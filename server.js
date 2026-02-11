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

async function validateImageHeader(filepath) {
    try {
        const buffer = Buffer.alloc(4);
        const fd = fs.openSync(filepath, 'r');
        fs.readSync(fd, buffer, 0, 4, 0);
        fs.closeSync(fd);
        const hex = buffer.toString('hex').toUpperCase();
        return hex.startsWith('FFD8') || hex.startsWith('89504E47');
    } catch (e) { return false; }
}

function escapeLatex(text) {
    if (typeof text !== 'string') return text || "";
    return text
        .replace(/\\/g, '')
        .replace(/([&%$#_{}])/g, '\\$1')
        .replace(/~/g, '$\\sim$')
        .replace(/\^/g, '\\^{}')
        .replace(/\[/g, '{[}').replace(/\]/g, '{]}')
        .replace(/\"/g, "''");
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

app.post('/analyze', upload.array('hefteintrag', 4), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.json({});
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
        
        const imageParts = req.files.map(f => ({
            inlineData: { data: fs.readFileSync(f.path).toString("base64"), mimeType: "image/jpeg" }
        }));

        const result = await model.generateContent([
            `Analysiere den Inhalt. Gib Fach, Klasse (Zahl) und Thema zurück. JSON: { "fach": "...", "klasse": "...", "thema": "..." }`,
            ...imageParts
        ]);
        
        req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        const text = result.response.text().replace(/```json|```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (err) {
        req.files?.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        res.status(500).json({error: "Analyse fehlgeschlagen."});
    }
});

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

        const systemPrompt = isEx 
            ? `Erstelle eine Stegreifaufgabe (20 Min, 3-4 Aufgaben). Fokus: Stoff der letzten 2 Stunden. AFB: 40/40/20.`
            : `Erstelle eine Schulaufgabe (60 Min, 5-6 Aufgaben). Fokus: Gesamte Sequenz. AFB: 40/40/20.`;

        const prompt = `
            ${systemPrompt}
            Fach: ${userFach}, Klasse: ${userKlasse}, Thema: ${userThema}.
            Regeln:
            1. Nutze bayerische Operatoren.
            2. LaTeX für Mathe ($...$).
            3. Teilaufgaben (a, b, c) sollen logisch getrennt sein.
            JSON Structure:
            {
                "titel": "${userThema}",
                "hilfsmittel": "${isEx ? 'Keine' : 'WTR, Merkhilfe'}",
                "aufgaben": [ { "text": "Aufgabentext...", "afb": "AFB I", "be": 5 } ]
            }
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
        const result = await model.generateContent([prompt, ...imageParts]);
        const data = JSON.parse(result.response.text());

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
        
        // SAFE LOGO COPY
        let logoLatex = `\\textbf{\\Large efectoTEC}`;
        const sourceLogo = path.join(__dirname, 'assets', 'logo.png');
        const targetLogo = path.join(tempDir, `logo_${runId}.png`);

        try {
            if (fs.existsSync(sourceLogo)) {
                fs.copyFileSync(sourceLogo, targetLogo);
                logoLatex = `\\raisebox{-0.5\\height}{\\includegraphics[height=1.5cm]{logo_${runId}.png}}`;
            }
        } catch (e) { }

        let taskLatex = "";
        data.aufgaben.forEach((t, i) => {
            if(!t.text) return; 
            
            let content = t.text.replace(/{{LUECKE}}/g, "\\luecke{4cm}");
            
            // Teilaufgaben Umbruch
            content = content.replace(/(\s|^)([a-e])\)/g, "\\\\ \\textbf{$2)}");

            // DESIGN FIX: AFB kleiner & ohne Klammern | Punkte rechtsbündig
            taskLatex += `
                \\section*{Aufgabe ${i+1} \\quad \\footnotesize ${escapeLatex(t.afb)}}
                ${content}
                \\par \\vspace{0.2cm} \\raggedleft \\textbf{/ ${t.be}~BE}
                \\vspace{0.3cm}
            `;
        });

        const texContent = `
        \\documentclass[a4paper,11pt]{article}
        \\usepackage[utf8]{inputenc}
        \\usepackage[ngerman]{babel}
        \\usepackage[T1]{fontenc}
        \\usepackage{lmodern}
        \\usepackage{amsmath, amssymb, geometry, fancyhdr, graphicx, tabularx, lastpage, array, eurosym}
        
        \\geometry{a4paper, top=2cm, bottom=2.5cm, left=2.5cm, right=2.5cm, headheight=4cm}
        \\newcommand{\\luecke}[1]{\\underline{\\hspace{#1}}}
        \\newcolumntype{Y}{>{\\centering\\arraybackslash}X}
        
        \\pagestyle{fancy}
        \\fancyhf{}
        \\renewcommand{\\headrulewidth}{0pt}
        \\fancyfoot[L]{\\small Seite \\thepage\\ von \\pageref{LastPage}}
        \\fancyfoot[R]{\\small Viel Erfolg wünscht dir efectoTEC!}

        \\begin{document}
            % --- HEADER FIX v1.16 (Name/Datum Flucht) ---
            \\noindent
            \\begin{tabularx}{\\textwidth}{@{}l X r@{}}
                ${logoLatex} & 
                \\centering \\Large \\textbf{${isEx ? 'Stegreifaufgabe' : 'Schulaufgabe'}} & 
                % NEU: 'l' statt 'r' sorgt für linke Flucht innerhalb des Blocks
                \\begin{tabular}[t]{@{}l@{}}
                    Name: \\luecke{5cm} \\\\[0.8em]
                    Datum: \\today
                \\end{tabular} \\\\
            \\end{tabularx}
            
            \\vspace{0.3cm}
            
            \\noindent
            \\textbf{Fach:} ${escapeLatex(userFach)} \\hfill 
            \\textbf{Klasse:} ${escapeLatex(userKlasse)} \\hfill 
            \\textbf{Zeit:} ${isEx ? '20 Min.' : '60 Min.'} \\hfill 
            \\textbf{Hilfsmittel:} ${escapeLatex(data.hilfsmittel)}
            
            \\vspace{0.2cm}
            \\hrule
            \\vspace{0.5cm}

            \\begin{center}
                \\large \\textbf{Thema:} ${escapeLatex(data.titel)}
            \\end{center}
            \\vspace{0.5cm}

            ${taskLatex}

            \\vfill

            \\begin{center}
            \\begin{minipage}{\\textwidth}
                \\noindent \\textbf{Bewertung:}
                \\vspace{0.2cm}
                
                \\centering
                \\renewcommand{\\arraystretch}{1.4}
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

        const compile = (cmd) => new Promise((resolve, reject) => {
            exec(cmd, (err, stdout, stderr) => {
                if (err) {
                    const errorDetails = stdout.slice(-300); 
                    return reject(new Error("LaTeX Error: " + errorDetails));
                }
                resolve();
            });
        });

        const cmd = `pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texPath}"`;
        await compile(cmd); 
        await compile(cmd); 

        const pdfPath = path.join(tempDir, `task_${runId}.pdf`);
        
        const cleanup = () => {
            try {
                files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path) }); 
                if (fs.existsSync(targetLogo)) fs.unlinkSync(targetLogo);
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
            res.status(500).send("PDF Fehler: Datei wurde nicht erstellt.");
        }

    } catch (err) {
        console.error("CRITICAL ERROR:", err);
        files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        res.status(500).send(err.message);
    }
});

app.listen(port, () => console.log(`efectoTEC v1.16 (Layout: Aligned & Clean) running on port ${port}`));