const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const rateLimit = require('express-rate-limit');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

app.use(rateLimit({ windowMs: 15*60*1000, max: 100 }));
app.use(cors());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const tempDir = os.tmpdir();
const uploadDir = path.join(tempDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function escapeLatex(text) {
    if (typeof text !== 'string') return text || "";
    return text.replace(/\\/g, '').replace(/([&%$#_])/g, '\\$1').replace(/{/g, '\\{').replace(/}/g, '\\}');
}

function calculateNotenschluessel(total) {
    const p = (pct) => Math.round(total * pct);
    return {
        1: `${total} - ${p(0.85)}`,
        2: `${p(0.85)-1} - ${p(0.70)}`,
        3: `${p(0.70)-1} - ${p(0.55)}`,
        4: `${p(0.55)-1} - ${p(0.40)}`,
        5: `${p(0.40)-1} - ${p(0.20)}`,
        6: `${p(0.20)-1} - 0`
    };
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/analyze', upload.array('hefteintrag', 3), async (req, res) => {
    try {
        if (!req.files) return res.json({});
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const imageParts = req.files.map(f => ({
            inlineData: { data: fs.readFileSync(f.path).toString("base64"), mimeType: "image/jpeg" }
        }));
        const result = await model.generateContent([
            `Analysiere Inhalt. Antworte JSON: { "fach": "...", "klasse": "...", "thema": "..." }`,
            ...imageParts
        ]);
        req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        res.json(JSON.parse(result.response.text().replace(/```json|```/g, '').trim()));
    } catch (err) {
        res.status(429).json({error: "Zu viele Anfragen"});
    }
});

app.post('/generate', upload.array('hefteintrag', 3), async (req, res) => {
    const runId = Date.now();
    try {
        const { userFach, userKlasse, userThema, examType } = req.body;
        const isEx = examType === 'ex';
        let imageParts = [];
        if (req.files) {
            imageParts = req.files.map(f => ({
                inlineData: { data: fs.readFileSync(f.path).toString("base64"), mimeType: "image/jpeg" }
            }));
        }

        const systemPrompt = isEx 
            ? `Erstelle Ex (20 Min). 3 Aufgaben. AFB I-II. JSON Output.`
            : `Erstelle Schulaufgabe (60 Min). 5 Aufgaben. AFB I-III. JSON Output.`;

        const prompt = `
            ${systemPrompt}
            Fach: ${userFach}, Klasse: ${userKlasse}, Thema: ${userThema}.
            Regeln:
            1. LaTeX für Mathe ($...$).
            2. Keine Markdown-Formatierung im JSON.
            
            JSON Structure:
            {
                "titel": "${userThema}",
                "hilfsmittel": "${isEx ? 'Keine' : 'WTR, Formelsammlung'}",
                "aufgaben": [ { "text": "...", "afb": "AFB I", "be": 5 } ]
            }
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
        const result = await model.generateContent([prompt, ...imageParts]);
        const data = JSON.parse(result.response.text());

        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });

        // --- LATEX LOGIK (FULL WIDTH FIX) ---
        const logoPath = "/app/assets/logo.png";
        
        let totalBE = 0;
        let taskHeaders = "";
        let maxBERow = "";
        let emptyRow = "";
        
        // Dynamische Spalten für TabularX (Aufgaben)
        // X = Automatische Breite
        data.aufgaben.forEach((t, i) => {
            totalBE += t.be;
            taskHeaders += ` ${i+1} &`; // Spaltenkopf 1, 2, 3...
            maxBERow += ` ${t.be} &`;   // Max BE Zeile
            emptyRow += ` &`;           // Leere Zeile für Lehrer
        });
        
        // Definition: Label (l) | X | X | ... | X | Gesamt (c)
        // Anzahl X Spalten = Anzahl Aufgaben
        const taskColDef = "|l|" + "X|".repeat(data.aufgaben.length) + "c|";
        const gradeColDef = "|l|X|X|X|X|X|X|"; // 6 Noten, gleich breit

        const notenSchluessel = calculateNotenschluessel(totalBE);

        let taskLatex = "";
        data.aufgaben.forEach((t, i) => {
            let content = t.text.replace(/{{LUECKE}}/g, "\\luecke{4cm}");
            taskLatex += `
                \\section*{Aufgabe ${i+1} \\small{(${escapeLatex(t.afb)})}}
                ${content} \\hfill \\textbf{/ ${t.be}~BE}
                \\vspace{1cm}
            `;
        });

        const texContent = `
        \\documentclass[a4paper,11pt]{article}
        \\usepackage[utf8]{inputenc}
        \\usepackage[ngerman]{babel}
        \\usepackage[T1]{fontenc}
        \\usepackage{lmodern}
        \\usepackage{amsmath, amssymb, geometry, fancyhdr, graphicx, tabularx, lastpage, array}
        
        % LAYOUT FIX: Top 5cm für Header reserviert
        \\geometry{top=5cm, left=2.5cm, right=2.5cm, bottom=2.5cm, headheight=3.5cm, footskip=1cm}
        \\linespread{1.25}
        
        \\newcommand{\\luecke}[1]{\\underline{\\hspace{#1}}}
        % Zentrierte Spalten in TabularX
        \\newcolumntype{Y}{>{\\centering\\arraybackslash}X}
        \\renewcommand{\\tabularxcolumn}[1]{>{\\centering\\arraybackslash}m{#1}}

        % HEADER
        \\pagestyle{fancy}
        \\fancyhf{}
        \\renewcommand{\\headrulewidth}{0pt}
        \\lhead{\\includegraphics[width=4cm]{${logoPath}}}
        \\rhead{
            \\small
            \\begin{tabular}{ll}
                \\textbf{Schuljahr 2026} & \\\\
                Name: \\luecke{4cm} & Klasse: ${escapeLatex(userKlasse)} \\\\
                Zeit: ${isEx ? '20 Min.' : '60 Min.'} & Datum: \\luecke{2.5cm} \\\\
                Hilfsmittel: ${escapeLatex(data.hilfsmittel)} &
            \\end{tabular}
        }
        \\cfoot{\\thepage}

        \\begin{document}
            \\begin{center}
                \\Large \\textbf{${isEx ? 'Stegreifaufgabe' : 'Schulaufgabe'} im Fach ${escapeLatex(userFach)}} \\\\
                \\large Thema: ${escapeLatex(data.titel)}
            \\end{center}
            \\vspace{0.5cm}

            ${taskLatex}

            % --- BEWERTUNGSTABELLE (FULL WIDTH) ---
            \\vfill
            \\begin{minipage}{\\textwidth}
                \\section*{Bewertung}
                
                % Tabelle 1: Punkte (Breit)
                \\renewcommand{\\arraystretch}{1.5}
                \\begin{tabularx}{\\textwidth}{${taskColDef}}
                    \\hline
                    \\textbf{Aufgabe} &${taskHeaders} \\textbf{Gesamt} \\\\
                    \\hline
                    Max. BE &${maxBERow} \\textbf{${totalBE}} \\\\
                    \\hline
                    Erreicht &${emptyRow}  \\\\
                    \\hline
                \\end{tabularx}
                
                \\vspace{0.5cm}
                
                % Tabelle 2: Noten (Breit)
                \\begin{tabularx}{\\textwidth}{${gradeColDef}}
                    \\hline
                    \\textbf{Note} & 1 & 2 & 3 & 4 & 5 & 6 \\\\
                    \\hline
                    Punkte & ${notenSchluessel[1]} & ${notenSchluessel[2]} & ${notenSchluessel[3]} & ${notenSchluessel[4]} & ${notenSchluessel[5]} & ${notenSchluessel[6]} \\\\
                    \\hline
                \\end{tabularx}
                
                \\vspace{1cm}
                \\Large \\textbf{Note:} \\luecke{3cm} \\hfill \\small \\textit{Viel Erfolg wünscht Dir efectoTEC!}
            \\end{minipage}

        \\end{document}
        `;

        const texPath = path.join(tempDir, `task_${runId}.tex`);
        fs.writeFileSync(texPath, texContent);

        exec(`pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texPath}"`, (err) => {
            const pdfPath = path.join(tempDir, `task_${runId}.pdf`);
            if (fs.existsSync(pdfPath)) {
                res.download(pdfPath, `efectoTEC_${userFach}.pdf`, () => {
                   // Cleanup Logik
                   try { 
                       [".tex", ".pdf", ".log", ".aux"].forEach(ext => fs.unlinkSync(path.join(tempDir, `task_${runId}${ext}`)));
                   } catch(e){}
                });
            } else {
                res.status(500).send("PDF Fehler");
            }
        });

    } catch (err) {
        res.status(500).send("Server Fehler: " + err.message);
    }
});

app.listen(port, () => console.log(`v1.5 Stable on ${port}`));