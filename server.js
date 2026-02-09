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

// Security & Setup
app.use(rateLimit({ windowMs: 15*60*1000, max: 100 }));
app.use(cors());

// Assets Route
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

// ROUTE: Startseite
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ROUTE: Analyse
app.post('/analyze', upload.array('hefteintrag', 3), async (req, res) => {
    try {
        if (!req.files) return res.json({});
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const imageParts = req.files.map(f => ({
            inlineData: { data: fs.readFileSync(f.path).toString("base64"), mimeType: "image/jpeg" }
        }));

        const result = await model.generateContent([
            `Analysiere den Inhalt. Gib Fach (z.B. Mathematik, Deutsch), Klasse (nur Zahl) und Thema zurück.
             JSON Format: { "fach": "...", "klasse": "...", "thema": "..." }`,
            ...imageParts
        ]);
        
        req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        res.json(JSON.parse(result.response.text().replace(/```json|```/g, '').trim()));
    } catch (err) {
        console.error(err);
        res.json({});
    }
});

// ROUTE: Generierung (v1.4 Layout Update)
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
            ? `Erstelle eine Stegreifaufgabe (Ex). Zeit: 20 Min. Umfang: 3 Aufgaben (ca. 20 BE). Fokus: Reproduktion (AFB I-II).`
            : `Erstelle eine Schulaufgabe. Zeit: 60 Min. Umfang: 5-6 Aufgaben (ca. 45-60 BE). Steigende Schwierigkeit (AFB I-III).`;

        const prompt = `
            ${systemPrompt}
            Fach: ${userFach}, Klasse: ${userKlasse}, Thema: ${userThema}.
            Regeln:
            1. Nutze bayerische Operatoren.
            2. Mache Absätze im Text für bessere Lesbarkeit.
            3. Lückentext-Platzhalter: {{LUECKE}}.
            4. Mathe LaTeX in $...$.
            
            JSON Output:
            {
                "titel": "${userThema}",
                "hilfsmittel": "${isEx ? 'Keine' : 'Nach Vorgabe'}",
                "aufgaben": [
                    { "text": "Aufgabentext...", "afb": "AFB I", "be": 5 }
                ]
            }
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
        const result = await model.generateContent([prompt, ...imageParts]);
        const data = JSON.parse(result.response.text());

        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });

        // --- LATEX CONSTRUCTION ---
        const logoPath = "/app/assets/logo.png"; 
        
        // Tabellen-Daten vorbereiten
        let totalBE = 0;
        let taskCells = "";
        let maxBECells = "";
        let gradeCells = "";
        
        data.aufgaben.forEach((t, i) => {
            totalBE += t.be;
            taskCells += `${i+1} & `;
            maxBECells += `${t.be} & `;
            gradeCells += ` & `;
        });

        const notenSchluessel = calculateNotenschluessel(totalBE);
        const colDef = "|" + "c|".repeat(data.aufgaben.length) + "c|";

        // Aufgaben zusammenbauen (Mehr Abstand!)
        let taskLatex = "";
        data.aufgaben.forEach((t, i) => {
            let content = t.text.replace(/{{LUECKE}}/g, "\\luecke{4cm}");
            taskLatex += `
                \\section*{Aufgabe ${i+1} \\small{(${escapeLatex(t.afb)})}}
                ${content} \\hfill \\textbf{/ ${t.be}~BE}
                \\vspace{1cm}  % Viel mehr Platz zwischen Aufgaben
            `;
        });

        const texContent = `
        \\documentclass[a4paper,11pt]{article}
        \\usepackage[utf8]{inputenc}
        \\usepackage[ngerman]{babel}
        \\usepackage[T1]{fontenc}
        \\usepackage{lmodern}
        \\usepackage{amsmath, amssymb, geometry, fancyhdr, graphicx, tabularx, lastpage, xcolor, array}
        
        % LAYOUT FIX: Top Margin erhöht auf 4.5cm, damit Header nicht in Text ragt
        \\geometry{top=4.5cm, left=2.5cm, right=2.5cm, bottom=2.5cm, headheight=3cm, footskip=1cm}
        \\linespread{1.25} % Luftigerer Zeilenabstand für bessere Lesbarkeit
        
        \\newcommand{\\luecke}[1]{\\underline{\\hspace{#1}}}

        % HEADER (Symmetrisch)
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

        % FOOTER (Nur noch Seitenzahl und Slogan)
        \\cfoot{
            \\small Seite \\thepage \\ von \\pageref{LastPage}
            \\hfill \\textit{Viel Erfolg wünscht Dir efectoTEC!}
        }

        \\begin{document}
            \\begin{center}
                \\Large \\textbf{${isEx ? 'Stegreifaufgabe' : 'Schulaufgabe'} im Fach ${escapeLatex(userFach)}} \\\\
                \\large Thema: ${escapeLatex(data.titel)}
            \\end{center}
            \\vspace{0.5cm}

            ${taskLatex}

            % FINALER BEWERTUNGS-BLOCK (Am Ende des Dokuments, nicht auf jeder Seite)
            \\vfill
            \\begin{minipage}{\\textwidth}
                \\centering
                \\textbf{Bewertung} \\\\[0.2cm]
                \\begin{tabular}{${colDef}}
                    \\hline
                    Aufg. & ${taskCells} Ges. \\\\
                    \\hline
                    Max. & ${maxBECells} ${totalBE} \\\\
                    \\hline
                    Ist & ${gradeCells} \\\\
                    \\hline
                \\end{tabular}
                \\\\[0.5cm]
                \\begin{tabular}{|l|c|c|c|c|c|c|}
                    \\hline
                    Note & 1 & 2 & 3 & 4 & 5 & 6 \\\\
                    \\hline
                    Pkte & ${notenSchluessel[1]} & ${notenSchluessel[2]} & ${notenSchluessel[3]} & ${notenSchluessel[4]} & ${notenSchluessel[5]} & ${notenSchluessel[6]} \\\\
                    \\hline
                \\end{tabular}
                \\\\[0.8cm]
                \\Large Note: \\luecke{3cm}
            \\end{minipage}

        \\end{document}
        `;

        const texPath = path.join(tempDir, `task_${runId}.tex`);
        fs.writeFileSync(texPath, texContent);

        exec(`pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texPath}"`, (err) => {
            const pdfPath = path.join(tempDir, `task_${runId}.pdf`);
            if (fs.existsSync(pdfPath)) {
                res.download(pdfPath, `efectoTEC_${userFach}.pdf`, () => {
                    [".tex", ".pdf", ".log", ".aux"].forEach(ext => {
                        try { fs.unlinkSync(path.join(tempDir, `task_${runId}${ext}`)) } catch(e){}
                    });
                });
            } else {
                res.status(500).send("PDF Error.");
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler: " + err.message);
    }
});

app.listen(port, () => console.log(`v1.4 Ready on ${port}`));