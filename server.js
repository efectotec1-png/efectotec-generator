/**
 * ============================================================================
 * PROJEKT: efectoTEC Schulaufgaben-Generator
 * DATEI:   server.js (Backend)
 * VERSION: v1.83-PREP (Layout Rollback & Debugging)
 * DATUM:   15.02.2026
 *
 * CHANGES:
 * - Layout: \vspace{0.5cm} nach Header entfernt (User-Wunsch).
 * - Layout: Leerzeichen vor ${processContent} entfernt.
 * - System: Debug-Log beim Start für TEST_MODE Status.
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

// WICHTIG: Dotenv muss als allererstes geladen werden
require('dotenv').config();

// --- CONFIG ---
const SERVER_VERSION = "v1.83-PREP";
const MODEL_NAME = "gemini-2.5-flash"; 
const PORT = process.env.PORT || 8080;

// Expliziter Check auf den String 'true'
const TEST_MODE = process.env.TEST_MODE && process.env.TEST_MODE.trim() === 'true';

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

// --- LEHRPLAN WISSEN (v1.81 Basis) ---
const LEHRPLAN_CONTEXT = {
    "5": "Niveau Klasse 5 (Gymnasium Bayern). Fokus: Natürliche Zahlen, Größen, Geometrische Grundfiguren. VERBOTEN: Variablen, Negative Zahlen, komplexe Brüche.",
    "6": "Niveau Klasse 6 (Gymnasium Bayern). Fokus: Bruch- und Dezimalrechnung, Flächeninhalt, Volumen, Rationale Zahlen (Einführung).",
    "7": "Niveau Klasse 7 (Gymnasium Bayern). Fokus: Terme, Gleichungen, Prozentrechnung, Kongruenz, Daten.",
    "8": "Niveau Klasse 8 (Gymnasium Bayern). Fokus: Funktionen, Lineare Gleichungssysteme, Laplace-Wahrscheinlichkeit, Kreis.",
    "9": "Niveau Klasse 9 (Gymnasium Bayern). Fokus: Quadratische Funktionen/Gleichungen, Satz des Pythagoras, Trigonometrie (Rechtwinklig), Potenzen.",
    "10": "Niveau Klasse 10 (Gymnasium Bayern). Fokus: Exponentialfunktion, Logarithmus, Trigonometrie (Allgemein), Kugel, Fortführung Wahrscheinlichkeit.",
    "11": "Niveau Oberstufe Q11 (Gymnasium Bayern). Fokus: Analysis (Differentialrechnung, Kurvendiskussion), Analytische Geometrie (Vektoren).",
    "12": "Niveau Oberstufe Q12 (Gymnasium Bayern). Fokus: Analysis (Integralrechnung), Stochastik (Kombinatorik, Hypothesentests).",
    "13": "Niveau Abitur Q13 (Gymnasium Bayern). Fokus: Abiturvorbereitung, Komplexaufgaben, Vernetzung aller Themen."
};

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
    try { 
        return JSON.parse(clean); 
    } catch (e) { 
        console.error("JSON Parse Error. Raw:", rawText); 
        throw new Error("KI lieferte defektes JSON."); 
    }
}

function cleanTitle(title) {
    if (!title) return "Thema nicht erkannt"; 
    let clean = title;
    const forbidden = ['Schulaufgabe', 'Stegreifaufgabe', 'Klasse', 'Exam', 'Test', 'Prüfung'];
    forbidden.forEach(word => { const regex = new RegExp(word, 'gi'); clean = clean.replace(regex, ''); });
    return clean.replace(/\s+/g, ' ').replace(/^[:\-\s]+|[:\-\s]+$/g, '').trim() || "Unbekanntes Thema";
}

function escapeLatex(text) {
    if (!text) return '';
    let clean = text.replace(/[^\w\s.,;:!?()+\-*/=%&€äöüÄÖÜß]/g, ''); 
    
    return clean
        .replace(/\\/g, '\\textbackslash{}')
        .replace(/&/g, '\\&')
        .replace(/%/g, '\\%')
        .replace(/\$/g, '\\$')
        .replace(/#/g, '\\#')
        .replace(/_/g, '\\_')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/~/g, '\\textasciitilde{}')
        .replace(/\^/g, '\\textasciicircum{}');
}

function cleanSubtaskLabel(text) {
    if (!text) return "";
    return text.replace(/^(\w\)|\d+\.|[-•])\s*/, '').trim();
}

function processContent(content) {
    if (!content) return "";
    let processed = escapeLatex(content);
    // Layout Fix: \allowbreak für Lücken
    processed = processed.replace(/(\\_){3,}/g, '\\luecke{3cm}');
    processed = processed.replace(/_{3,}/g, '\\luecke{3cm}');
    return processed;
}

function fileToGenerativePart(path, mimeType) {
    return { inlineData: { data: fs.readFileSync(path).toString("base64"), mimeType }, };
}

const SYSTEM_PROMPT = `
Du bist ein professioneller Lehrer an einem Gymnasium in Bayern. 
DEINE AUFGABE: Erstelle eine Schulaufgabe basierend auf den Bildern im JSON-Format.

KRITISCHE REGELN:
1. Analysiere ZUERST die Klassenstufe. Passe Schwierigkeit und Themen exakt an.
2. NIEMALS Math-Mode ($...$) für normalen Text verwenden.
3. Unteraufgaben (a, b, c) MÜSSEN im "subtasks"-Array landen. SCHREIBE NIEMALS "a)" in den Text der Unteraufgabe selbst!
4. Jede Aufgabe MUSS eine "loesung" enthalten.
5. Der "titel" darf NUR das Thema enthalten.

JSON-SCHEMA: { "titel": "Thema (Kurz)", "hilfsmittel": "Hilfsmittel", "aufgaben": [ { "anweisung": "Frage", "inhalt": "Text", "loesung": "Lsg", "subtasks": [ { "inhalt": "Text ohne Label", "loesung": "Lsg" } ], "punkte": 10 } ] }
`;
const DUMMY_DATA = { titel: "Test-Modus", hilfsmittel: "Keine", aufgaben: [ { anweisung: "Berechne.", inhalt: "", loesung: "", subtasks: [{inhalt: "2+2", loesung: "4"}, {inhalt: "4+4", loesung: "8"}], punkte: 4 } ] };

function calculateNotenschluessel(total) {
    const p = (pct) => Math.round(total * pct);
    return { 1: `${total} - ${p(0.85)}`, 2: `${p(0.85)-1} - ${p(0.70)}`, 3: `${p(0.70)-1} - ${p(0.55)}`, 4: `${p(0.55)-1} - ${p(0.45)}`, 5: `${p(0.45)-1} - ${p(0.20)}`, 6: `${p(0.20)-1} - 0` };
}

// --- ROUTEN ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.post('/analyze', upload.array('hefteintrag', 3), async (req, res) => {
    if (TEST_MODE) {
        console.log("ANALYZE: Nutze TEST_MODE Dummy Daten");
        return res.json({ fach: "Mathematik", klasse: "9", thema: "Test Analyse" });
    }
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "Kein Bild." });
    
    try {
        const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { responseMimeType: "application/json", temperature: 0.4 } });
        const imageParts = req.files.map(f => fileToGenerativePart(f.path, f.mimetype));
        
        const timeout = newPf => new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000));
        
        const analyzePromise = model.generateContent([`Analysiere Bilder. JSON: { "fach": "...", "klasse": "5-13", "thema": "..." }`, ...imageParts]);
        
        const result = await Promise.race([analyzePromise, timeout()]);
        const json = parseGeminiJSON(result.response.text());
        
        if (!json.fach) json.fach = "Sonstiges";
        if (!json.klasse) json.klasse = "9";
        if (!json.thema) json.thema = "Thema nicht erkannt";

        req.files.forEach(f => fs.unlinkSync(f.path));
        res.json(json);
    } catch (e) { 
        if(req.files) req.files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        console.error("Analyse Fehler:", e.message);
        res.json({ fach: "Sonstiges", klasse: "9", thema: "Nicht erkannt (Timeout/Fehler)" });
    }
});

app.post('/generate', upload.array('hefteintrag', 5), async (req, res) => {
    const runId = Date.now();
    try {
        const { userFach, userKlasse, userThema, examType } = req.body;
        const isEx = examType === 'ex';
        let examData;

        let displayKlasse = (userKlasse && userKlasse.trim() !== "") ? userKlasse : "9";
        // Fach-Weiche für v1.83 (Verhindert Geologie -> Mathe Fehler)
        let contextInstruction = "Allgemeines Niveau. Passe Aufgaben an Bildinhalt an.";
        if (userFach && (userFach.toLowerCase().includes('mathe') || userFach.toLowerCase().includes('physik'))) {
             contextInstruction = LEHRPLAN_CONTEXT[displayKlasse.replace(/\D/g, '')] || "Gymnasiales Niveau Bayern.";
        }

        if (!TEST_MODE && req.files && req.files.length > 0) {
            const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: { responseMimeType: "application/json" } });
            const imageParts = req.files.map(f => fileToGenerativePart(f.path, f.mimetype));
            
            const prompt = `${SYSTEM_PROMPT} 
            KONTEXT: Fach ${userFach || "Allgemein"}, Klasse ${displayKlasse}. 
            LEHRPLAN-VORGABE: ${contextInstruction}
            THEMA-USER: ${userThema}
            WICHTIG: Erstelle Aufgaben passend zum BILDINHALT. Wenn das Bild Geographie ist, mache KEINE Matheaufgaben.
            AUFTRAG: Erstelle eine ${isEx ? 'kurze Stegreifaufgabe (20min)' : 'umfassende Schulaufgabe (60min)'}.`;
            
            const result = await model.generateContent([prompt, ...imageParts]);
            examData = parseGeminiJSON(result.response.text());

            if (!examData.aufgaben || examData.aufgaben.length === 0) {
                throw new Error("KI konnte keine Aufgaben aus dem Bild extrahieren.");
            }

        } else {
            console.log("GENERATE: Nutze TEST_MODE Dummy Daten");
            examData = DUMMY_DATA;
            examData.titel = userThema || "Test Thema";
        }

        let totalBE = 0;
        if(examData.aufgaben) examData.aufgaben.forEach(t => totalBE += (t.punkte || t.be || 0));
        if (totalBE === 0) totalBE = 20; 
        const notenSchluessel = calculateNotenschluessel(totalBE);

        let logoLatex = `\\textbf{efectoTEC}`;
        const sourceLogo = path.join(__dirname, 'assets', 'logo.png');
        const targetLogo = path.join(tempDir, `logo_${runId}.png`);
        try { if (fs.existsSync(sourceLogo)) { fs.copyFileSync(sourceLogo, targetLogo); logoLatex = `\\includegraphics[width=3.5cm]{logo_${runId}.png}`; } } catch (e) {}
        
        const dateStr = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
        const cleanTitelText = cleanTitle(examData.titel);

        let taskLatex = ""; let solutionLatex = ""; let taskHeaders = ""; let maxBERow = ""; let emptyRow = "";
        
        if(examData.aufgaben) {
            examData.aufgaben.forEach((t, i) => {
                const punkte = t.punkte || t.be || 0;
                // UPDATE v1.83: \vspace{0.5cm} entfernt (Rollback)
                let block = `\\noindent \\textbf{Aufgabe ${i+1}} \\hfill \\small{/ ${punkte} BE} \\\\ \n`;
                // UPDATE v1.83: Leerzeichen vor ${processContent} entfernt
                if (t.anweisung) block += `\\noindent ${processContent(t.anweisung)} \\par \\vspace{0.2cm} \n`;
                if (t.inhalt && t.inhalt.length > 2) block += `\\noindent ${processContent(t.inhalt)} \\par \\vspace{0.2cm} \n`;
                
                if (t.subtasks && t.subtasks.length > 0) {
                    block += `\\begin{enumerate}[label=\\alph*), leftmargin=*, nosep, itemsep=0.5cm] \n`;
                    t.subtasks.forEach(sub => { 
                        block += `\\item ${processContent(cleanSubtaskLabel(sub.inhalt || sub.text || ""))} \n`; 
                    });
                    block += `\\end{enumerate} \n`;
                }
                block += `\\vspace{1.0cm} \n`;
                taskLatex += block;

                // Lösung
                let solBlock = `\\noindent \\textbf{Zu Aufgabe ${i+1}} \\\\ \n`;
                if (t.loesung && t.loesung.length > 1) solBlock += `${processContent(t.loesung)} \\par \n`;
                if (t.subtasks && t.subtasks.length > 0) {
                   if (t.subtasks.some(s => s.loesung)) {
                        solBlock += `\\begin{enumerate}[label=\\alph*), leftmargin=*, nosep] \n`;
                        t.subtasks.forEach(sub => { solBlock += `\\item ${processContent(sub.loesung || "-")} \n`; });
                        solBlock += `\\end{enumerate} \n`;
                   }
                }
                solBlock += `\\vspace{0.5cm} \n`;
                solutionLatex += solBlock;
                taskHeaders += ` ${i+1} &`; maxBERow += ` ${punkte} &`; emptyRow += ` &`;
            });
        }
        
        const numTasks = examData.aufgaben ? examData.aufgaben.length : 1;
        const taskColDef = "|c|" + "X|".repeat(numTasks) + "c|";
        const gradeColDef = "|c|X|X|X|X|X|X|";

        const headerDefinition = `
        \\newcommand{\\myHeader}[1]{
            \\noindent
            \\makebox[0pt][l]{\\raisebox{-0.97\\height}{${logoLatex}}}%
            \\begin{center}
                \\parbox[t]{0.8\\textwidth}{\\centering \\Huge \\textbf{#1}} \\\\[0.3cm]
                \\large im Fach \\textbf{${processContent(userFach || "Allgemein")}} der ${displayKlasse}. Klasse \\\\[0.2cm]
                \\parbox[t]{0.8\\textwidth}{\\centering \\normalsize Thema: \\textbf{${processContent(cleanTitelText)}}}
            \\end{center}
            \\vspace{0.2cm}
            \\noindent
            \\textbf{Datum:} ${dateStr} \\\\
            \\textbf{Zeit:} ${isEx ? '20 Min.' : '60 Min.'} \\\\
            \\textbf{Hilfsmittel:} ${processContent(examData.hilfsmittel || "Keine")}
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
        
        \\newcommand{\\luecke}[1]{\\allowbreak\\underline{\\hspace{#1}}}
        
        \\newcolumntype{Y}{>{\\centering\\arraybackslash}X}
        \\setlength{\\parindent}{0pt}
        ${headerDefinition}
        \\pagestyle{fancy} \\fancyhf{} \\renewcommand{\\headrulewidth}{0pt}
        \\fancyfoot[L]{\\small v1.83 | Seite \\thepage\\ von \\pageref{LastPage}}
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
    console.log(`TEST_MODE Status: ${TEST_MODE}`); // DEBUGGING
    console.log(`Server running on port ${PORT}`);
    console.log(`--------------------------------------------------`);
});