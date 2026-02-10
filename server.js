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

// Assets Route (Bedient robot.png UND logo.png)
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const tempDir = os.tmpdir();
const uploadDir = path.join(tempDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Lastenheft 3.1: Max 4 Bilder
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Security: Magic Bytes (Lastenheft 5.1)
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
        4: `${p(0.55)-1} - ${p(0.45)}`, 5: `${p(0.45)-1} - ${p(0.20)}`, 6: `${p(0.20)-1} - 0`
    };
}

// --- ROUTEN ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Analyse Route
app.post('/analyze', upload.array('hefteintrag', 4), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.json({});
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
        
        const imageParts = req.files.map(f => ({
            inlineData: { data: fs.readFileSync(f.path).toString("base64"), mimeType: "image/jpeg" }
        }));

        const result = await model.generateContent([
            `Analysiere den Inhalt. Gib Fach (wähle aus: Mathematik, Deutsch, Englisch, Latein, Französisch, Physik, Chemie, Wirtschaft und Recht, Musik, Spanisch, Italienisch, Griechisch, Sonstiges), Klasse (5-13 als Zahl) und ein kurzes Thema zurück.
             JSON Format: { "fach": "...", "klasse": "...", "thema": "..." }`,
            ...imageParts
        ]);
        
        req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        const text = result.response.text().replace(/```json|```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (err) {
        req.files?.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        res.status(500).json({error: "Analyse fehlgeschlagen (API Limit oder Dateifehler)."});
    }
});

// Generierung Route
app.post('/generate', upload.array('hefteintrag', 4), async (req, res) => {
    const runId = Date.now();
    const files = req.files || [];
    
    try {
        const { userFach, userKlasse, userThema, examType } = req.body;
        const isEx = examType === 'ex';
        
        for (const file of files) {
            if (!await validateImageHeader(file.path)) throw new Error("Security: Ungültiges Dateiformat.");
        }

        const imageParts = files.map(f => ({
            inlineData: { data: fs.readFileSync(f.path).toString("base64"), mimeType: "image/jpeg" }
        }));

        // Lastenheft 3.3: AFB 40/40/20 & Modell 2.5 Flash
        const systemPrompt = isEx 
            ? `Erstelle eine Stegreifaufgabe (20 Min, 3-4 Aufgaben). Fokus: Stoff der letzten 2 Stunden (Bilder). AFB Verteilung: 40% I, 40% II, 20% III.`
            : `Erstelle eine Schulaufgabe (60 Min, 5-6 Aufgaben). Fokus: Gesamte Lernsequenz. AFB Verteilung: 40% I, 40% II, 20% III.`;

        const prompt = `
            ${systemPrompt}
            Fach: ${userFach}, Klasse: ${userKlasse}, Thema: ${userThema}.
            Regeln:
            1. Nutze bayerische Operatoren (Nenne, Berechne, Begründe).
            2. LaTeX für Mathe ($...$).
            JSON Structure:
            {
                "titel": "${userThema}",
                "hilfsmittel": "${isEx ? 'Keine' : 'WTR, Merkhilfe, Formelsammlung'}",
                "aufgaben": [ { "text": "Aufgabentext...", "afb": "AFB I", "be": 5 } ]
            }
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
        const result = await model.generateContent([prompt, ...imageParts]);
        const data = JSON.parse(result.response.text());

        // Layout Berechnung
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
        
        const taskColDef = "|c|" + "X|".repeat(data.aufgaben.length) + "c|";
        const gradeColDef = "|c|X|X|X|X|X|X|"; 
        const notenSchluessel = calculateNotenschluessel(totalBE);
        
        // WICHTIG: Hier nutzen wir jetzt logo.png für das PDF!
        const logoPath = path.resolve(__dirname, 'assets/logo.png');

        let taskLatex = "";
        data.aufgaben.forEach((t, i) => {
            let content = t.text.replace(/{{LUECKE}}/g, "\\luecke{4cm}");
            taskLatex += `
                \\section*{Aufgabe ${i+1} \\small{(${escapeLatex(t.afb)})}}
                ${content} \\hfill \\textbf{/ ${t.be}~BE}
                \\vspace{0.5cm}
            `;
        });

        // LASTENHEFT 4.1 Header & 4.2 Footer & 4.3 Tabelle
        const texContent = `
        \\documentclass[a4paper,11pt]{article}
        \\usepackage[utf8]{inputenc}
        \\usepackage[ngerman]{babel}
        \\usepackage[T1]{fontenc}
        \\usepackage{lmodern}
        \\usepackage{amsmath, amssymb, geometry, fancyhdr, graphicx, tabularx, lastpage, array, eurosym}
        
        \\geometry{a4paper, top=2cm, bottom=2.5cm, left=2.5cm, right=2.5cm, headheight=3.5cm}
        \\newcommand{\\luecke}[1]{\\underline{\\hspace{#1}}}
        
        % Tabellen-Zentrierung (Lastenheft 4.3)
        \\newcolumntype{Y}{>{\\centering\\arraybackslash}X}
        
        % Footer (Lastenheft 4.2 - Seite X von Y)
        \\pagestyle{fancy}
        \\fancyhf{}
        \\renewcommand{\\headrulewidth}{0pt}
        \\fancyfoot[L]{\\small Seite \\thepage\\ von \\pageref{LastPage}}
        \\fancyfoot[R]{\\small Viel Erfolg wünscht dir efectoTEC!}

        \\begin{document}

            % --- HEADER GRID (Lastenheft 4.1) ---
            % Zeile 1: Logo (links) | Titel (mitte) | Name (rechts)
            \\noindent
            \\begin{tabularx}{\\textwidth}{@{}l X r@{}}
                \\raisebox{-0.5\\height}{\\includegraphics[height=1.5cm]{${logoPath.replace(/\\/g, '/')}}} & 
                \\centering \\Large \\textbf{1. ${isEx ? 'Stegreifaufgabe' : 'Schulaufgabe'}} & 
                Name: \\luecke{5cm} \\\\
            \\end{tabularx}
            
            \\vspace{0.4cm}
            
            % Zeile 2: Metadaten A
            \\noindent
            \\textbf{Fach:} ${escapeLatex(userFach)} \\hfill \\textbf{Klasse:} ${escapeLatex(userKlasse)} \\hfill \\textbf{Datum:} \\today
            
            \\vspace{0.2cm}
            
            % Zeile 3: Metadaten B
            \\noindent
            \\textbf{Zeit:} ${isEx ? '20 Min.' : '60 Min.'} \\hfill \\textbf{Hilfsmittel:} ${escapeLatex(data.hilfsmittel)}
            
            \\vspace{0.3cm}
            \\hrule
            \\vspace{0.5cm}

            \\begin{center}
                \\large \\textbf{Thema:} ${escapeLatex(data.titel)}
            \\end{center}
            \\vspace{0.5cm}

            % AUFGABEN
            ${taskLatex}

            % ABSCHLUSS (Lastenheft 4.2)
            \\vfill
            \\begin{center}
                \\small \\textit{Viel Erfolg bei deiner ${isEx ? 'EX' : 'SA'} wünscht dir efectoTEC!}
            \\end{center}

            % BEWERTUNGSTABELLE (Lastenheft 4.3 - Zentriert)
            \\noindent
            \\textbf{Bewertung:}
            \\begin{center}
            \\begin{minipage}{\\textwidth}
                \\centering
                \\renewcommand{\\arraystretch}{1.4}
                % Punkte
                \\begin{tabularx}{\\textwidth}{${taskColDef}}
                    \\hline
                    \\textbf{Aufg.} &${taskHeaders} \\textbf{Gesamt} \\\\
                    \\hline
                    Max. &${maxBERow} \\textbf{${totalBE}} \\\\
                    \\hline
                    Err. &${emptyRow}  \\\\
                    \\hline
                \\end{tabularx}
                
                \\vspace{0.2cm}
                
                % Noten
                \\begin{tabularx}{\\textwidth}{${gradeColDef}}
                    \\hline
                    \\textbf{Note} & 1 & 2 & 3 & 4 & 5 & 6 \\\\
                    \\hline
                    Pkte & ${notenSchluessel[1]} & ${notenSchluessel[2]} & ${notenSchluessel[3]} & ${notenSchluessel[4]} & ${notenSchluessel[5]} & ${notenSchluessel[6]} \\\\
                    \\hline
                \\end{tabularx}
                
                \\vspace{0.8cm}
                \\Large \\textbf{Erreichte Punkte:} \\luecke{2cm} / ${totalBE} \\quad \\textbf{Note:} \\luecke{2cm}
            \\end{minipage}
            \\end{center}

        \\end{document}
        `;

        const texPath = path.join(tempDir, `task_${runId}.tex`);
        fs.writeFileSync(texPath, texContent);

        // --- DOUBLE COMPILE LOOP (Fix für Seite ?? von ??) ---
        const compile = (cmd) => new Promise((resolve, reject) => {
            exec(cmd, (err) => err ? reject(err) : resolve());
        });

        const cmd = `pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texPath}"`;
        
        // 1. Durchlauf (erzeugt .aux)
        await compile(cmd);
        // 2. Durchlauf (löst Referenzen auf)
        await compile(cmd);

        const pdfPath = path.join(tempDir, `task_${runId}.pdf`);
        
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
            res.download(pdfPath, `efectoTEC_${examType.toUpperCase()}_${userFach}.pdf`, cleanup);
        } else {
            cleanup();
            res.status(500).send("PDF Fehler.");
        }

    } catch (err) {
        files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        res.status(500).send(err.message);
    }
});

app.listen(port, () => console.log(`efectoTEC v1.10 (Double-Compile & Logo Fix) running on port ${port}`));