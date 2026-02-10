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

// Security: Rate Limiting
app.use(rateLimit({ windowMs: 15*60*1000, max: 100 }));
app.use(cors());

// Assets Route (Wichtig für Logo)
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Temp Ordner Logik
const tempDir = os.tmpdir();
const uploadDir = path.join(tempDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// LASTENHEFT NEU: Max 4 Bilder (vorher 3)
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Security: Magic Bytes Check (Lastenheft 5.1)
async function validateImageHeader(filepath) {
    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(filepath, 'r');
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    const hex = buffer.toString('hex').toUpperCase();
    return hex.startsWith('FFD8') || hex.startsWith('89504E47');
}

function escapeLatex(text) {
    if (typeof text !== 'string') return text || "";
    return text.replace(/\\/g, '').replace(/([&%$#_])/g, '\\$1').replace(/{/g, '\\{').replace(/}/g, '\\}');
}

function calculateNotenschluessel(total) {
    const p = (pct) => Math.round(total * pct);
    return {
        1: `${total} - ${p(0.85)}`, 2: `${p(0.85)-1} - ${p(0.70)}`, 3: `${p(0.70)-1} - ${p(0.55)}`,
        4: `${p(0.55)-1} - ${p(0.40)}`, 5: `${p(0.40)-1} - ${p(0.20)}`, 6: `${p(0.20)-1} - 0`
    };
}

// Route Startseite
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route Analyse
app.post('/analyze', upload.array('hefteintrag', 4), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.json({});
        // API FIX: Nutzung von gemini-2.5-flash statt 2.0
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
        
        const imageParts = req.files.map(f => ({
            inlineData: { data: fs.readFileSync(f.path).toString("base64"), mimeType: "image/jpeg" } // Force JPEG mime for stability
        }));

        const result = await model.generateContent([
            `Analysiere den Inhalt. Gib Fach, Klasse (Zahl) und Thema zurück.
             JSON Format: { "fach": "...", "klasse": "...", "thema": "..." }`,
            ...imageParts
        ]);
        
        req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        const text = result.response.text().replace(/```json|```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (err) {
        console.error("Analyse Fehler:", err.message);
        req.files?.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        res.status(500).json({error: "Fehler bei der Analyse (evtl. API Limit)."});
    }
});

// Route Generierung
app.post('/generate', upload.array('hefteintrag', 4), async (req, res) => {
    const runId = Date.now();
    const files = req.files || [];
    
    try {
        const { userFach, userKlasse, userThema, examType } = req.body;
        const isEx = examType === 'ex';
        
        // Security Check
        for (const file of files) {
            if (!await validateImageHeader(file.path)) throw new Error("Security: Ungültige Datei erkannt.");
        }

        const imageParts = files.map(f => ({
            inlineData: { data: fs.readFileSync(f.path).toString("base64"), mimeType: "image/jpeg" }
        }));

        // Lastenheft: AFB 40/40/20 Verteilung
        const systemPrompt = isEx 
            ? `Erstelle eine Stegreifaufgabe (20 Min, 3 Aufgaben). AFB I(40%)/II(40%)/III(20%).`
            : `Erstelle eine Schulaufgabe (60 Min, 5 Aufgaben). AFB I(40%)/II(40%)/III(20%).`;

        const prompt = `
            ${systemPrompt}
            Fach: ${userFach}, Klasse: ${userKlasse}, Thema: ${userThema}.
            Regeln:
            1. Nutze bayerische Operatoren.
            2. LaTeX für Mathe ($...$).
            JSON Structure:
            {
                "titel": "${userThema}",
                "hilfsmittel": "${isEx ? 'Keine' : 'WTR, Merkhilfe'}",
                "aufgaben": [ { "text": "Aufgabentext...", "afb": "AFB I", "be": 5 } ]
            }
        `;

        // API FIX: gemini-2.5-flash
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
        const result = await model.generateContent([prompt, ...imageParts]);
        const data = JSON.parse(result.response.text());

        // Layout Logik
        let totalBE = 0;
        let taskHeaders = "";
        let maxBERow = "";
        let emptyRow = "";
        data.aufgaben.forEach((t, i) => {
            totalBE += t.be;
            taskHeaders += ` ${i+1} &`;
            maxBERow += ` ${t.be} &`;
            emptyRow += ` &`;
        });
        
        const taskColDef = "|l|" + "X|".repeat(data.aufgaben.length) + "c|";
        const gradeColDef = "|l|X|X|X|X|X|X|"; 
        const notenSchluessel = calculateNotenschluessel(totalBE);
        
        // Logo Pfad für Docker (absolut) - Stellt sicher, dass robot.png genutzt wird
        const logoPath = path.resolve(__dirname, 'assets/robot.png');

        let taskLatex = "";
        data.aufgaben.forEach((t, i) => {
            let content = t.text.replace(/{{LUECKE}}/g, "\\luecke{4cm}");
            taskLatex += `
                \\section*{Aufgabe ${i+1} \\small{(${escapeLatex(t.afb)})}}
                ${content} \\hfill \\textbf{/ ${t.be}~BE}
                \\vspace{0.6cm}
            `;
        });

        // LASTENHEFT 4.1 Header (Tabularx Grid)
        const texContent = `
        \\documentclass[a4paper,11pt]{article}
        \\usepackage[utf8]{inputenc}
        \\usepackage[ngerman]{babel}
        \\usepackage[T1]{fontenc}
        \\usepackage{lmodern}
        \\usepackage{amsmath, amssymb, geometry, fancyhdr, graphicx, tabularx, lastpage, array, eurosym}
        
        \\geometry{a4paper, top=2cm, bottom=2.5cm, left=2.5cm, right=2.5cm, headheight=2.5cm}
        \\newcommand{\\luecke}[1]{\\underline{\\hspace{#1}}}
        
        % Footer (Lastenheft 4.2)
        \\pagestyle{fancy}
        \\fancyhf{}
        \\renewcommand{\\headrulewidth}{0pt}
        \\fancyfoot[C]{\\small Seite \\thepage\\ von \\pageref{LastPage} \\quad | \\quad efectoTEC | we \\heartsuit\\ ROBOTs}

        \\begin{document}
            % HEADER GRID
            \\noindent
            \\begin{tabularx}{\\textwidth}{@{}l X r@{}}
                \\includegraphics[height=1.4cm]{${logoPath.replace(/\\/g, '/')}} & 
                \\centering \\Large \\textbf{1. ${isEx ? 'Stegreifaufgabe' : 'Schulaufgabe'} aus der ${escapeLatex(userFach)}} & 
                Name: \\luecke{4cm} \\\\
                 & 
                \\centering \\small Klasse: ${escapeLatex(userKlasse)} \\quad Datum: \\today & 
                Hilfsmittel: ${escapeLatex(data.hilfsmittel)} \\\\
            \\end{tabularx}
            \\vspace{0.2cm}
            \\hrule
            \\vspace{0.5cm}

            \\begin{center}
                \\large Thema: ${escapeLatex(data.titel)}
            \\end{center}
            \\vspace{0.5cm}

            ${taskLatex}

            \\vfill
            \\begin{center}
                \\small \\textit{Viel Erfolg bei deiner ${isEx ? 'EX' : 'SA'} wünscht dir efectoTEC!}
            \\end{center}

            \\noindent
            \\textbf{Bewertung:}
            \\begin{minipage}{\\textwidth}
                \\centering
                \\renewcommand{\\arraystretch}{1.3}
                \\begin{tabularx}{\\textwidth}{${taskColDef}}
                    \\hline
                    \\textbf{Aufgabe} &${taskHeaders} \\textbf{Gesamt} \\\\
                    \\hline
                    Max. BE &${maxBERow} \\textbf{${totalBE}} \\\\
                    \\hline
                    Erreicht &${emptyRow}  \\\\
                    \\hline
                \\end{tabularx}
                \\vspace{0.3cm}
                \\begin{tabularx}{\\textwidth}{${gradeColDef}}
                    \\hline
                    \\textbf{Note} & 1 & 2 & 3 & 4 & 5 & 6 \\\\
                    \\hline
                    Pkte & ${notenSchluessel[1]} & ${notenSchluessel[2]} & ${notenSchluessel[3]} & ${notenSchluessel[4]} & ${notenSchluessel[5]} & ${notenSchluessel[6]} \\\\
                    \\hline
                \\end{tabularx}
                \\vspace{0.5cm}
                \\Large \\textbf{Erreichte Punkte:} \\luecke{2cm} / ${totalBE} \\quad \\textbf{Note:} \\luecke{2cm}
            \\end{minipage}
        \\end{document}
        `;

        const texPath = path.join(tempDir, `task_${runId}.tex`);
        fs.writeFileSync(texPath, texContent);

        exec(`pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texPath}"`, (err) => {
            const pdfPath = path.join(tempDir, `task_${runId}.pdf`);
            
            // CLEANER (Lastenheft 5.2)
            const cleanup = () => {
                try {
                    files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path) }); 
                    [".tex", ".pdf", ".log", ".aux"].forEach(ext => {
                        const p = path.join(tempDir, `task_${runId}${ext}`);
                        if (fs.existsSync(p)) fs.unlinkSync(p);
                    });
                } catch(e) {}
            };

            if (fs.existsSync(pdfPath)) {
                res.download(pdfPath, `efectoTEC_${examType.toUpperCase()}.pdf`, cleanup);
            } else {
                cleanup();
                res.status(500).send("PDF Fehler (LaTeX Compile Failed).");
            }
        });

    } catch (err) {
        files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        res.status(500).send(err.message);
    }
});

app.listen(port, () => console.log(`efectoTEC v1.9 (Compliance Update) running on port ${port}`));