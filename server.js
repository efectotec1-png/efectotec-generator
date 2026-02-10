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

const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- SECURITY: MAGIC BYTES CHECK (Lastenheft 5.1) ---
async function validateImageHeader(filepath) {
    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(filepath, 'r');
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    
    const hex = buffer.toString('hex').toUpperCase();
    // JPEG (FFD8...), PNG (89504E47...)
    if (hex.startsWith('FFD8') || hex.startsWith('89504E47')) {
        return true;
    }
    return false;
}

// LaTeX Helper
function escapeLatex(text) {
    if (typeof text !== 'string') return text || "";
    return text.replace(/\\/g, '').replace(/_/g, '\\_').replace(/%/g, '\\%').replace(/\$/g, '\\$').replace(/#/g, '\\#');
}

// --- HAUPTROUTE ---
app.post('/generate', upload.array('hefteintrag', 3), async (req, res) => {
    const runId = Date.now();
    const files = req.files || [];
    const { examType } = req.body; // 'ex' oder 'sa'

    console.log(`[${runId}] Start Generierung: ${examType.toUpperCase()} mit ${files.length} Dateien.`);

    if (files.length === 0) return res.status(400).send("Keine Dateien hochgeladen.");

    try {
        // 1. Security Check (Magic Bytes)
        for (const file of files) {
            const isValid = await validateImageHeader(file.path);
            if (!isValid) {
                throw new Error("Sicherheitswarnung: Eine Datei ist kein gültiges Bild (Magic Bytes Check fehlgeschlagen).");
            }
        }

        // 2. Bild-Vorbereitung für Gemini
        const imageParts = files.map(file => ({
            inlineData: {
                data: fs.readFileSync(file.path).toString("base64"),
                mimeType: file.mimetype
            }
        }));

        // 3. Prompt Engineering (Lastenheft: AFB 40/40/20 & Didaktik)
        const userFach = "Mathematik"; // TODO: Im Frontend dropdown hinzufügen, aktuell hardcoded Default
        const userKlasse = "8a";
        const examTypeLabel = examType === 'ex' ? 'Stegreifaufgabe' : 'Schulaufgabe';
        const duration = examType === 'ex' ? '20 Min.' : '60 Min.';
        
        // AFB Verteilung Logik
        const afbInstruction = `
        STRIKTE ANFORDERUNGSBEREICHE (AFB) - Lastenheft Vorgabe:
        - 40% AFB I (Reproduktion): Nenne, Beschreibe, Definiere.
        - 40% AFB II (Reorganisation): Erkläre, Vergleiche, Berechne.
        - 20% AFB III (Transfer): Beurteile, Übertrage auf neue Kontexte.
        `;

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash", // Nutze 2.0 Flash (schnell & gut) oder 1.5 Pro
            systemInstruction: `Du bist ein bayerischer Gymnasiallehrer. 
            Erstelle eine ${examTypeLabel} für die Klasse ${userKlasse} im Fach ${userFach}.
            ${afbInstruction}
            
            OUTPUT FORMAT:
            Gib NUR reinen LaTeX-Code für den 'document'-Body zurück. 
            Keine Präambel, kein \\begin{document}.
            Nutze 'tabularx' für Layouts.
            Erstelle Aufgaben mit Punkten.
            `
        });

        const prompt = `
        Analysiere diese Hefteinträge/Bilder.
        Erstelle darauf basierend 3-4 prüfungsrelevante Aufgaben.
        Summe der Punkte: ${examType === 'ex' ? '20' : '60'}.
        Formatiere Aufgaben sauber mit \\section*{Aufgabe X}.
        Füge am Ende eine kurze Musterlösung an.
        `;

        const result = await model.generateContent([prompt, ...imageParts]);
        const responseText = result.response.text();
        
        const cleanLatexBody = responseText.replace(/```latex/g, '').replace(/```/g, '').trim();

        // 4. Notenschlüssel Berechnung (Linear)
        const maxPunkte = examType === 'ex' ? 20 : 60;
        const notenSchluessel = {
            1: Math.floor(maxPunkte * 0.88),
            2: Math.floor(maxPunkte * 0.74),
            3: Math.floor(maxPunkte * 0.59),
            4: Math.floor(maxPunkte * 0.44),
            5: Math.floor(maxPunkte * 0.20),
            6: 0
        };

        // 5. LaTeX Master-Template (Lastenheft 4.1 & 4.2)
        const texContent = `
        \\documentclass[a4paper,11pt]{article}
        \\usepackage[ngerman]{babel}
        \\usepackage[utf8]{inputenc}
        \\usepackage[T1]{fontenc}
        \\usepackage{amsmath, amssymb}
        \\usepackage{graphicx}
        \\usepackage{geometry}
        \\usepackage{fancyhdr}
        \\usepackage{tabularx} 
        \\usepackage{lastpage} % Für "Seite X von Y"
        \\usepackage{eurosym}

        % Layout Setup (Golden Rules & Header Space)
        \\geometry{a4paper, left=2.5cm, right=2.5cm, top=2cm, bottom=2.5cm, headheight=2.5cm}

        % Header & Footer Definition (Lastenheft)
        \\pagestyle{fancy}
        \\fancyhf{} 
        \\renewcommand{\\headrulewidth}{0pt} % Linie manuell im Body setzen
        \\fancyfoot[C]{\\small Seite \\thepage\\ von \\pageref{LastPage} \\quad | \\quad efectoTEC | we \\heartsuit\\ ROBOTs}

        \\newcommand{\\luecke}[1]{\\underline{\\hspace{#1}}}

        \\begin{document}

            % --- HEADER (Lastenheft 4.1 Tabularx Grid) ---
            \\noindent
            \\begin{tabularx}{\\textwidth}{@{}l X r@{}}
                \\includegraphics[height=1.2cm]{assets/logo.png} & 
                \\centering \\Large \\textbf{1. ${examTypeLabel} aus der ${userFach}} & 
                Name: \\luecke{4cm} \\\\
                 & 
                \\centering \\small Klasse: ${userKlasse} \\quad Datum: \\today & 
                Hilfsmittel: WTR, Merkhilfe \\\\
            \\end{tabularx}
            \\vspace{0.2cm}
            \\hrule
            \\vspace{0.5cm}

            % --- INHALT VOM KI-MODELL ---
            ${cleanLatexBody}

            % --- ABSCHLUSS & BEWERTUNG ---
            \\vfill
            \\begin{center}
                \\small \\textit{Viel Erfolg bei deiner ${examType === 'ex' ? 'EX' : 'SA'} wünscht dir efectoTEC!}
            \\end{center}
            
            \\noindent
            \\textbf{Bewertung:}
            \\begin{minipage}{\\textwidth}
                \\centering
                \\begin{tabularx}{\\textwidth}{|X|c|c|c|c|c|c|}
                    \\hline
                    Note & 1 & 2 & 3 & 4 & 5 & 6 \\\\
                    \\hline
                    Pkte & ab ${notenSchluessel[1]} & ab ${notenSchluessel[2]} & ab ${notenSchluessel[3]} & ab ${notenSchluessel[4]} & ab ${notenSchluessel[5]} & < ${notenSchluessel[5]} \\\\
                    \\hline
                \\end{tabularx}
                
                \\vspace{0.5cm}
                \\Large \\textbf{Erreichte Punkte:} \\luecke{2cm} / ${maxPunkte} \\quad \\textbf{Note:} \\luecke{2cm}
            \\end{minipage}

        \\end{document}
        `;

        const texPath = path.join(tempDir, `task_${runId}.tex`);
        fs.writeFileSync(texPath, texContent);

        // PDF Kompilierung
        exec(`pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texPath}"`, (err) => {
            const pdfPath = path.join(tempDir, `task_${runId}.pdf`);
            
            // Cleanup Funktion (Privacy by Design - sofortiges Löschen)
            const cleanup = () => {
                try {
                    files.forEach(f => fs.unlinkSync(f.path)); // Uploads löschen
                    [".tex", ".pdf", ".log", ".aux"].forEach(ext => {
                        const p = path.join(tempDir, `task_${runId}${ext}`);
                        if (fs.existsSync(p)) fs.unlinkSync(p);
                    });
                    console.log(`[${runId}] Cleanup complete (Privacy-by-Design).`);
                } catch(e) { console.error("Cleanup Error:", e); }
            };

            if (fs.existsSync(pdfPath)) {
                res.download(pdfPath, `efectoTEC_${examType.toUpperCase()}_${runId}.pdf`, cleanup);
            } else {
                cleanup();
                console.error("PDF Error:", err);
                res.status(500).send("PDF Generierung fehlgeschlagen. (LaTeX Error)");
            }
        });

    } catch (error) {
        console.error("Critical Error:", error);
        files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); }); // Notfall Cleanup
        res.status(500).send(error.message);
    }
});

// Fallback Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
    console.log(`efectoTEC Generator v1.7 running on port ${port}`);
    console.log(`- Lastenheft v7.0 Compliance: ACTIVE`);
    console.log(`- Security: Magic Bytes ACTIVE`);
});