/**
 * ============================================================================
 * PROJEKT: efectoTEC Schulaufgaben-Generator
 * DATEI:   server.js (Backend)
 * VERSION: v1.80-CORE (STABLE ROLLBACK)
 * DATUM:   14.02.2026
 *
 * STATUS:  Last Known Good Configuration.
 * FEATURES:
 * - Keine Voting-Experimente (Stateless).
 * - Robuster PDF-Upload & Generierung.
 * - Liest Frontend-Version aus Meta-Tag.
 * ============================================================================
 */
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

// --- CONFIG ---
const SERVER_VERSION = "v1.80-CORE";
const MODEL_NAME = "gemini-2.5-flash"; 
const PORT = process.env.PORT || 8080;
const TEST_MODE = process.env.TEST_MODE === 'true'; 

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const app = express();

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(cors());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.use((req, res, next) => {
    res.header('Access-Control-Expose-Headers', 'Content-Disposition');
    next();
});

const tempDir = os.tmpdir();
const uploadDir = path.join(tempDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// --- HELPER: Frontend Version Check ---
function getFrontendVersion() {
    try {
        const indexPath = path.join(__dirname, 'index.html');
        if (fs.existsSync(indexPath)) {
            const content = fs.readFileSync(indexPath, 'utf8');
            const match = content.match(/name=["']app-version["']\s+content=["']([^"']+)["']/i);
            if (match && match[1]) return match[1];
        }
    } catch (e) {}
    return "unknown";
}

function parseGeminiJSON(rawText) {
    let clean = rawText.trim();
    clean = clean.replace(/^```json/, '').replace(/```$/, '').replace(/^```/, '');
    clean = clean.replace(/\\'/g, "'");
    try { return JSON.parse(clean); } catch (e) { console.error("JSON Parse Error. Raw:", rawText); throw new Error("KI lieferte defektes JSON."); }
}

function cleanTitle(title) {
    if (!title) return "";
    let clean = title;
    const forbidden = ['Schulaufgabe', 'Stegreifaufgabe', 'Klasse', 'Exam', 'Test', 'Prüfung'];
    forbidden.forEach(word => { const regex = new RegExp(word, 'gi'); clean = clean.replace(regex, ''); });
    return clean.replace(/\s+/g, ' ').replace(/^[:\-\s]+|[:\-\s]+$/g, '').trim();
}

function escapeLatex(text) {
    if (!text) return '';
    return text.replace(/\\/g, '\\textbackslash{}').replace(/&/g, '\\&').replace(/%/g, '\\%').replace(/\$/g, '\\$').replace(/#/g, '\\#').replace(/_/g, '\\_').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
}

function processContent(content) {
    if (!content) return "";
    let processed = escapeLatex(content);
    processed = processed.replace(/(\\_){3,}/g, '\\luecke{3cm}');
    processed = processed.replace(/_{3,}/g, '\\luecke{3cm}');
    return processed;
}

function fileToGenerativePart(path, mimeType) {
    return { inlineData: { data: fs.readFileSync(path).toString("base64"), mimeType }, };
}

const SYSTEM_PROMPT = `
Du bist ein professioneller Lehrer an einem Gymnasium in Bayern. 
Du erstellst Prüfungen streng nach Lehrplan. Verwende ausschließlich Standarddeutsch (Hochdeutsch).
DEINE AUFGABE: Erstelle eine Schulaufgabe basierend auf den Bildern im folgenden JSON-Format.
KRITISCHE REGELN:
1. NIEMALS Math-Mode ($...$) für normalen Text verwenden.
2. Lückentexte IMMER als normalen Text mit Platzhalter _____ (5 Unterstriche).
3. Unteraufgaben (a, b, c) MÜSSEN im "subtasks"-Array landen.
4. Jede Aufgabe MUSS eine "loesung" enthalten.
5. Der "titel" darf NUR das Thema enthalten.
JSON-SCHEMA: { "titel": "Thema (Kurz)", "hilfsmittel": "Hilfsmittel", "aufgaben": [ { "anweisung": "Frage", "inhalt": "Text", "loesung": "Lsg", "subtasks": [ { "inhalt": "a)", "loesung": "b)" } ], "punkte": 10 } ] }
`;
const DUMMY_DATA = { titel: "Test-Modus", hilfsmittel: "Keine", aufgaben: [ { anweisung: "Berechne.", inhalt: "", loesung: "", subtasks: [{inhalt: "2+2", loesung: "4"}, {inhalt: "4+4", loesung: "8"}], punkte: 4 } ] };

function calculateNotenschluessel(total) {
    const p = (pct) => Math.round(total * pct);
    return { 1: `${total} - ${p(0.85)}`, 2: `${p(0.85)-1} - ${p(0.70)}`, 3: `${p(0.70)-1} - ${p(0.55)}`, 4: `${p(0.55)-1} - ${p(0.45)}`, 5: `${p(0.45)-1} - ${p(0.20)}`, 6: `${p(0.20)-1} - 0` };
}

// --- ROUTEN ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.post('/analyze', upload.array('hefteintrag', 3), async (req, res) => {
    if (TEST_MODE) return res.json({ fach: "Mathe", klasse: "10", thema: "Test" });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "Kein Bild." });
    try {
        const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { responseMimeType: "application/json" } });
        const imageParts = req.files.map(f => fileToGenerativePart(f.path, f.mimetype));
        const result = await model.generateContent([`Analysiere Bilder. JSON: { "fach": "...", "klasse": "...", "thema": "..." }`, ...imageParts]);
        const json = parseGeminiJSON(result.response.text());
        req.files.forEach(f => fs.unlinkSync(f.path));
        res.json(json);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/generate', upload.array('hefteintrag', 5), async (req, res) => {
    const runId = Date.now();
    try {
        const { userFach, userKlasse, userThema, examType } = req.body;
        const isEx = examType === 'ex';
        let examData;

        if (!TEST_MODE && req.files && req.files.length > 0) {
            const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { responseMimeType: "application/json" } });
            const imageParts = req.files.map(f => fileToGenerativePart(f.path, f.mimetype));
            const prompt = `${SYSTEM_PROMPT} Kontext: Fach ${userFach}, Klasse ${userKlasse}, Thema ${userThema}.`;
            const result = await model.generateContent([prompt, ...imageParts]);
            examData = parseGeminiJSON(result.response.text());
        } else {
            examData = DUMMY_DATA;
            examData.titel = userThema || "Test Thema";
        }

        let totalBE = 0;
        if(examData.aufgaben) examData.aufgaben.forEach(t => totalBE += (t.punkte || t.be || 0));
        const notenSchluessel = calculateNotenschluessel(totalBE);

        let logoLatex = `\\textbf{efectoTEC}`;
        const sourceLogo = path.join(__dirname, 'assets', 'logo.png');
        const targetLogo = path.join(tempDir, `logo_${runId}.png`);
        try { if (fs.existsSync(sourceLogo)) { fs.copyFileSync(sourceLogo, targetLogo); logoLatex = `\\includegraphics[width=3.5cm]{logo_${runId}.png}`; } } catch (e) {}
        const dateStr = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
        let displayKlasse = (userKlasse && userKlasse.trim() !== "") ? userKlasse : "9";
        const cleanTitelText = cleanTitle(examData.titel);

        let taskLatex = ""; let solutionLatex = ""; let taskHeaders = ""; let maxBERow = ""; let emptyRow = "";
        if(examData.aufgaben) {
            examData.aufgaben.forEach((t, i) => {
                const punkte = t.punkte || t.be || 0;
                let block = `\\noindent \\textbf{Aufgabe ${i+1}} \\hfill \\small{/ ${punkte} BE} \\\\ \n`;
                if (t.anweisung) block += `\\noindent ${processContent(t.anweisung)} \\par \\vspace{0.3cm} \n`;
                if (t.inhalt && t.inhalt.length > 2) block += `\\noindent ${processContent(t.inhalt)} \\par \\vspace{0.3cm} \n`;
                if (t.subtasks && t.subtasks.length > 0) {
                    block += `\\begin{enumerate}[label=\\alph*), leftmargin=*, nosep] \n`;
                    t.subtasks.forEach(sub => { block += `\\item ${processContent(sub.inhalt || sub.text || "")} \n`; });
                    block += `\\end{enumerate} \n`;
                }
                block += `\\vspace{1.0cm} \n`;
                taskLatex += block;

                let solBlock = `\\noindent \\textbf{Zu Aufgabe ${i+1}} \\\\ \n`;
                if (t.loesung && t.loesung.length > 1) solBlock += `${processContent(t.loesung)} \\par \n`;
                if (t.subtasks && t.subtasks.length > 0) {
                    if (t.subtasks.some(s => s.loesung && s.loesung.length > 0)) {
                        solBlock += `\\begin{enumerate}[label=\\alph*), leftmargin=*, nosep] \n`;
                        t.subtasks.forEach(sub => { solBlock += `\\item ${processContent(sub.loesung || "Lösung folgt")} \n`; });
                        solBlock += `\\end{enumerate} \n`;
                    }
                }
                solBlock += `\\vspace{0.5cm} \n`;
                solutionLatex += solBlock;
                taskHeaders += ` ${i+1} &`; maxBERow += ` ${punkte} &`; emptyRow += ` &`;
            });
        }
        const taskColDef = "|c|" + "X|".repeat(examData.aufgaben ? examData.aufgaben.length : 1) + "c|";
        const gradeColDef = "|c|X|X|X|X|X|X|";

        const headerDefinition = `
        \\newcommand{\\myHeader}[1]{
            \\noindent
            \\makebox[0pt][l]{\\raisebox{-0.97\\height}{${logoLatex}}}%
            \\begin{center}
                \\parbox[t]{0.8\\textwidth}{\\centering \\Huge \\textbf{#1}} \\\\[0.3cm]
                \\large im Fach \\textbf{${userFach}} der ${displayKlasse}. Klasse \\\\[0.2cm]
                \\parbox[t]{0.8\\textwidth}{\\centering \\normalsize Thema: \\textbf{${cleanTitelText}}}
            \\end{center}
            \\vspace{0.2cm}
            \\noindent
            \\textbf{Datum:} ${dateStr} \\\\
            \\textbf{Zeit:} ${isEx ? '20 Min.' : '60 Min.'} \\\\
            \\textbf{Hilfsmittel:} ${examData.hilfsmittel}
            \\vspace{0.5cm}
            \\hrule
            \\vspace{1.0cm}
        }`;

        const texContent = `
        \\documentclass[a4paper,11pt]{article}
        \\usepackage[utf8]{inputenc}
        \\usepackage[ngerman]{babel}
        \\usepackage[T1]{fontenc}
        \\usepackage{lmodern, amsmath, amssymb, geometry, fancyhdr, graphicx, tabularx, lastpage, array, enumitem}
        \\geometry{a4paper, top=1.5cm, bottom=2.5cm, left=2.5cm, right=2.5cm, headheight=4cm}
        \\newcommand{\\luecke}[1]{\\underline{\\hspace{#1}}}
        \\newcolumntype{Y}{>{\\centering\\arraybackslash}X}
        \\setlength{\\parindent}{0pt}
        ${headerDefinition}
        \\pagestyle{fancy} \\fancyhf{} \\renewcommand{\\headrulewidth}{0pt}
        \\fancyfoot[L]{\\small v1.66 | Seite \\thepage\\ von \\pageref{LastPage}}
        \\fancyfoot[R]{\\small Viel Erfolg wünscht dir efectoTEC!}
        \\begin{document}
            \\vspace*{-1.0cm} \\myHeader{${isEx ? 'Stegreifaufgabe' : 'Schulaufgabe'}}
            ${taskLatex}
            \\vfill
            \\noindent
            \\begin{minipage}{\\textwidth}
                \\textbf{Bewertung:} \\par \\vspace{0.3cm} \\renewcommand{\\arraystretch}{1.5}
                \\begin{tabularx}{\\textwidth}{${taskColDef}} 
                    \\hline \\textbf{Aufg.} &${taskHeaders} \\textbf{Gesamt} \\\\ 
                    \\hline Max. &${maxBERow} \\textbf{${totalBE}} \\\\ 
                    \\hline Err. &${emptyRow}  \\\\ \\hline 
                \\end{tabularx}
                \\vspace{0.8cm}
                \\begin{tabularx}{\\textwidth}{${gradeColDef}} 
                    \\hline \\textbf{Note} & 1 & 2 & 3 & 4 & 5 & 6 \\\\ 
                    \\hline Pkte & ${notenSchluessel[1]} & ${notenSchluessel[2]} & ${notenSchluessel[3]} & ${notenSchluessel[4]} & ${notenSchluessel[5]} & ${notenSchluessel[6]} \\\\ \\hline 
                \\end{tabularx}
                \\vspace{1cm} \\hfill \\Large \\textbf{Note: \\luecke{3cm}}
            \\end{minipage}
            \\newpage \\null \\vspace*{-1.0cm}
            \\myHeader{Musterlösung} 
            ${solutionLatex}
        \\end{document}`;

        const texPath = path.join(tempDir, `task_${runId}.tex`);
        fs.writeFileSync(texPath, texContent);
        
        const cmd = `pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texPath}"`;
        exec(cmd, (err) => {
            exec(cmd, () => {
                exec(cmd, (errFinal) => { 
                    if (errFinal) console.error("LATEX FEHLER");
                    const pdfPath = path.join(tempDir, `task_${runId}.pdf`);
                    if (fs.existsSync(pdfPath)) {
                        const counterPath = path.join(__dirname, 'counter.json');
                        let counter = 1;
                        if (fs.existsSync(counterPath)) { try { counter = JSON.parse(fs.readFileSync(counterPath)).count + 1; } catch(e){} }
                        fs.writeFileSync(counterPath, JSON.stringify({count: counter}));
                        
                        const filename = `efectoTEC_${isEx ? 'EX' : 'SA'}_${counter}.pdf`;
                        res.download(pdfPath, filename, () => {
                           try { 
                               [".tex", ".pdf", ".log", ".aux"].forEach(ext => {
                                   const p = path.join(tempDir, `task_${runId}${ext}`);
                                   if(fs.existsSync(p)) fs.unlinkSync(p);
                               });
                               if (req.files) req.files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
                           } catch(e){}
                        });
                    } else { res.status(500).send("PDF Erstellung fehlgeschlagen."); }
                });
            });
        });

    } catch (err) { console.error("Server Error:", err.message); res.status(500).send("Fehler: " + err.message); }
});

app.listen(PORT, () => {
    const frontVer = getFrontendVersion();
    console.log(`--------------------------------------------------`);
    console.log(`efectoTEC Backend: ${SERVER_VERSION}`);
    console.log(`efectoTEC Frontend: ${frontVer}`);
    console.log(`Server running on port ${PORT}`);
    console.log(`--------------------------------------------------`);
});