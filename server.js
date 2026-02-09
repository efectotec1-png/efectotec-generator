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

// 1. SECURITY & SETUP
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 Minuten
    max: 100, // Limit pro IP
    message: "Zu viele Anfragen. Bitte warten."
});
app.use(limiter);
app.use(cors());
app.use(express.static('public')); // Für statische Files falls nötig

// Temp-Verzeichnis für Cloud Run (Im Speicher)
const tempDir = os.tmpdir();
const uploadDir = path.join(tempDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ 
    dest: uploadDir,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit
});

// KI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Hilfsfunktion: LaTeX Escaping
function escapeLatex(text) {
    if (typeof text !== 'string') return text || "";
    return text
        .replace(/\\/g, '')
        .replace(/([&%$#_])/g, '\\$1')
        .replace(/~/g, '\\textasciitilde ')
        .replace(/\^/g, '\\textasciicircum ')
        .replace(/{/g, '\\{')
        .replace(/}/g, '\\}');
}

// ROUTEN
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// STUFE 1: ANALYSE
app.post('/analyze', upload.array('hefteintrag', 3), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({error: "Kein Bild"});

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const imageParts = req.files.map(file => ({
            inlineData: { 
                data: fs.readFileSync(file.path).toString("base64"), 
                mimeType: "image/jpeg" 
            }
        }));

        const prompt = `Analysiere diese Hefteinträge. Identifiziere Fach, Klasse (nur Zahl) und das konkrete Thema. 
        Antworte NUR als JSON: { "fach": "...", "klasse": "...", "thema": "..." }`;

        const result = await model.generateContent([prompt, ...imageParts]);
        const text = result.response.text();
        const jsonStr = text.replace(/```json|```/g, '').trim();
        const analysis = JSON.parse(jsonStr);

        // Cleanup Uploads sofort
        req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });

        res.json(analysis);
    } catch (err) {
        console.error("Analyse Fehler:", err);
        res.status(500).json({ error: "Analyse fehlgeschlagen" });
    }
});

// STUFE 2: GENERIERUNG (Das Herzstück)
app.post('/generate', upload.array('hefteintrag', 3), async (req, res) => {
    const runId = Date.now();
    const texPath = path.join(tempDir, `task_${runId}.tex`);
    const pdfPath = path.join(tempDir, `task_${runId}.pdf`);

    try {
        const { userFach, userKlasse, userThema, examType } = req.body;
        
        // Bilder verarbeiten (falls im 2. Schritt erneut hochgeladen oder gepuffert)
        let imageParts = [];
        if (req.files && req.files.length > 0) {
            imageParts = req.files.map(file => ({
                inlineData: { 
                    data: fs.readFileSync(file.path).toString("base64"), 
                    mimeType: "image/jpeg" 
                }
            }));
        }

        // PROMPT LOGIK (Meilenstein 2: Ex vs. SA)
        let systemPrompt = "";
        if (examType === "ex") {
            systemPrompt = `Du bist ein bayerischer Lehrer. Erstelle eine Stegreifaufgabe (Ex).
            Zeit: 20 Min. Fokus: Nur Inhalte der Bilder/Thema.
            Operatoren: Nennen, Skizzieren, Einfaches Erläutern (AFB I & II).
            Umfang: 3 kurze Aufgaben. Gesamtpunkte: ca. 20 BE.`;
        } else {
            systemPrompt = `Du bist ein bayerischer Lehrer. Erstelle eine Schulaufgabe (Großer Leistungsnachweis).
            Zeit: 60 Min. Fokus: Thema vertiefen + Transferaufgaben (G9 Lehrplan).
            Operatoren: Analysieren, Begründen, Beurteilen (AFB I, II, III).
            Umfang: 4-5 Aufgaben, steigende Komplexität. Gesamtpunkte: ca. 40-50 BE.`;
        }

        const prompt = `
            ${systemPrompt}
            Fach: ${userFach}, Klasse: ${userKlasse}, Thema: ${userThema}.
            Erstelle validen JSON Output für folgende Struktur:
            {
                "titel": "${userThema}",
                "aufgaben": [
                    { "titel": "Aufgabentitel", "afb": "AFB I", "text": "LaTeX Code der Frage", "be": 5 },
                    ...
                ]
            }
            WICHTIG: Nutze für Mathe LaTeX Umgebungen ($...$). Keine Markdown-Formatierung im JSON.
        `;

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            generationConfig: { responseMimeType: "application/json" }
        });

        const result = await model.generateContent([prompt, ...imageParts]);
        const data = JSON.parse(result.response.text());

        // Cleanup Uploads
        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });

        // LATEX TEMPLATE ENGINE (Meilenstein 1: Dein PDF Design)
        // Wir nutzen absolute Pfade für Docker (/app/assets/...)
        const logoPath = "/app/assets/logo.png"; 
        const robotPath = "/app/assets/robot.png";

        // Berechnung der Gesamtpunkte für die Tabelle
        let totalBE = 0;
        let taskRows = "";
        let beRow = "";
        
        data.aufgaben.forEach((task, index) => {
            totalBE += task.be;
            // Body Content
            taskRows += `
                \\section*{Aufgabe ${index + 1} (${escapeLatex(task.afb)})}
                ${task.text} \\hfill \\textbf{/ ${task.be} BE}
                \\vspace{1cm}
            `;
            // Footer Table Logic (dynamisch bis zu 6 Aufgaben, dann Umbruch)
            beRow += `${index + 1} & `;
        });

        // BE Tabelle Aufbauen
        let beTableConfig = "|"; 
        for(let i=0; i<data.aufgaben.length; i++) beTableConfig += "c|";
        beTableConfig += "c|"; // Für Gesamt

        let beValues = "";
        for(let i=0; i<data.aufgaben.length; i++) beValues += `${data.aufgaben[i].be} & `;
        
        const latexContent = `
        \\documentclass[a4paper,11pt]{article}
        \\usepackage[utf8]{inputenc}
        \\usepackage[ngerman]{babel}
        \\usepackage[T1]{fontenc}
        \\usepackage{amsmath, amssymb, geometry, fancyhdr, graphicx, tabularx, lastpage, xcolor}
        
        % Layout wie in deiner Vorlage
        \\geometry{top=3cm, left=2.5cm, right=2.5cm, bottom=3cm, headheight=50pt}
        
        % Header Definition
        \\pagestyle{fancy}
        \\fancyhf{}
        \\lhead{\\includegraphics[height=1.2cm]{${logoPath}}} 
        \\rhead{
            \\begin{tabular}{r l}
                \\textbf{Schuljahr 2026} & \\\\
                Name: & \\rule{4cm}{0.4pt} \\\\
                Klasse: ${escapeLatex(userKlasse)} & Datum: \\rule{2.5cm}{0.4pt}
            \\end{tabular}
        }
        
        % Footer Definition (Notenschlüssel & Branding)
        \\cfoot{
            \\small
            \\textbf{Bewertung:} \\\\[0.2cm]
            \\begin{tabular}{${beTableConfig}}
                \\hline
                Aufgabe & ${beRow} Gesamt \\\\
                \\hline
                Max. BE & ${beValues} ${totalBE} \\\\
                \\hline
                Erreicht & ${"& ".repeat(data.aufgaben.length)} \\\\
                \\hline
            \\end{tabular}
            \\\\[0.5cm]
            \\begin{tabular}{|l|c|c|c|c|c|c|}
                \\hline
                Note & 1 & 2 & 3 & 4 & 5 & 6 \\\\
                \\hline
                Punkte & \\hspace{0.5cm} & \\hspace{0.5cm} & \\hspace{0.5cm} & \\hspace{0.5cm} & \\hspace{0.5cm} & \\hspace{0.5cm} \\\\
                \\hline
            \\end{tabular}
            \\\\[0.5cm]
            \\begin{minipage}{0.7\\textwidth}
                \\tiny Unterschrift Lehrkraft: \\hrulefill \\\\
                Kenntnisnahme Eltern: \\hrulefill
            \\end{minipage}
            \\hfill
            \\includegraphics[height=1.5cm]{${robotPath}}
            \\begin{minipage}{0.2\\textwidth}
                \\textbf{\\textcolor{blue}{we ❤️ ROBOTs}}
            \\end{minipage}
        }

        \\begin{document}
            \\begin{center}
                \\Large \\textbf{${examType === 'ex' ? 'Stegreifaufgabe' : 'Schulaufgabe'} im Fach ${escapeLatex(userFach)}} \\\\
                \\large Thema: ${escapeLatex(data.titel)}
            \\end{center}
            \\vspace{0.5cm}
            
            ${taskRows}

            \\vfill
            \\footnotesize Erstellt mit efectoTEC GNERATOR
        \\end{document}
        `;

        fs.writeFileSync(texPath, latexContent);

        // PDF Generierung (2x Ausführen für Layout-Berechnung falls nötig, hier reicht oft 1x für basic)
        exec(`pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texPath}"`, (error, stdout, stderr) => {
            if (fs.existsSync(pdfPath)) {
                res.download(pdfPath, `Schulaufgabe_${userFach}.pdf`, () => {
                    // Aufräumen
                    const extensions = ['.tex', '.pdf', '.log', '.aux'];
                    extensions.forEach(ext => {
                        const f = path.join(tempDir, `task_${runId}${ext}`);
                        if (fs.existsSync(f)) fs.unlinkSync(f);
                    });
                });
            } else {
                console.error("LaTeX Error Log:", stdout);
                res.status(500).send("Fehler bei der PDF-Erstellung. Der LaTeX-Code war ungültig.");
            }
        });

    } catch (err) {
        console.error("Generierungs-Fehler:", err);
        res.status(500).send("Server Fehler: " + err.message);
    }
});

app.listen(port, () => console.log(`GNERATOR v1.1 bereit auf Port ${port}`));