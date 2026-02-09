const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;
const tempDir = os.tmpdir();
const uploadDir = path.join(tempDir, 'efectotec_uploads');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Config: Erlaubt bis zu 3 Bilder gleichzeitig
const upload = multer({ dest: uploadDir });

// KI Config
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash", 
  generationConfig: { responseMimeType: "application/json", temperature: 0.3 } 
});

// Helper
function escapeLatex(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\\/g, '').replace(/([&%$#_])/g, '\\$1').replace(/~/g, '\\textasciitilde ').replace(/\^/g, '\\textasciicircum ');
}

// --- ROUTE 1: ANALYSE (Der "Magic Pre-Check") ---
app.post('/analyze', upload.array('hefteintrag', 3), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: "Keine Bilder." });

        console.log(`-> Analyse-Request: ${req.files.length} Bilder`);

        // Bilder für Gemini vorbereiten
        const imageParts = req.files.map(file => ({
            inlineData: {
                data: fs.readFileSync(file.path).toString("base64"),
                mimeType: "image/jpeg"
            }
        }));

        const prompt = `
            Analysiere diese Hefteinträge/Skizzen.
            Identifiziere:
            1. Das Schulfach (z.B. Mathematik, Physik).
            2. Die vermutliche Klasse (Bayerisches Gymnasium G9, z.B. "9").
            3. Das konkrete Thema (z.B. "Quadratische Funktionen").
            
            Antworte NUR mit JSON:
            { "fach": "...", "klasse": "...", "thema": "..." }
        `;

        const result = await model.generateContent([prompt, ...imageParts]);
        const responseText = result.response.text();
        const analysis = JSON.parse(responseText.replace(/```json/g, '').replace(/```/g, '').trim());
        
        console.log("-> Analyse Ergebnis:", analysis);
        
        // Cleanup sofort, wir brauchen die Bilder erst beim Generate wieder
        req.files.forEach(f => fs.unlinkSync(f.path));

        res.json(analysis);

    } catch (err) {
        console.error("Analyse Fehler:", err);
        res.status(500).json({ error: err.message });
    }
});


// --- ROUTE 2: GENERIERUNG (Der "Heavy Lifter") ---
app.post('/generate', upload.array('hefteintrag', 3), async (req, res) => {
  let texFilename, pdfFilename;

  try {
    // Wir holen uns die bestätigten Daten vom Frontend
    const { userFach, userKlasse, userThema } = req.body;
    console.log(`-> Generiere: ${userFach}, Kl. ${userKlasse}, Thema: ${userThema}`);

    const imageParts = req.files.map(file => ({
        inlineData: { data: fs.readFileSync(file.path).toString("base64"), mimeType: "image/jpeg" }
    }));

    // Der präzise Lehrplan-Prompt
    const prompt = `
      Rolle: Bayerischer Gymnasiallehrer (G9).
      Aufgabe: Erstelle eine Schulaufgabe für das Fach ${userFach}, Klasse ${userKlasse}.
      Thema: ${userThema}.
      Basis: Nutze die hochgeladenen Bilder als Inspiration für Aufgabenstellungen, aber halte dich strikt an den LehrplanPLUS für Klasse ${userKlasse}.
      
      ANFORDERUNGEN:
      1. Umfang: 60 Minuten (ca. 28-32 BE).
      2. Niveau: Mix aus AFB I (30%), II (50%), III (20%).
      3. Format: Valides JSON.
      
      JSON OUTPUT:
      {
        "titel": "Schulaufgabe: ${userThema}",
        "fach": "${userFach}",
        "klasse": "${userKlasse}",
        "zeit": "60 Min",
        "hilfsmittel": "Taschenrechner, Merkhilfe",
        "aufgaben": [
          { "text": "LaTeX Code hier", "be": 4, "afb": "I" }
        ],
        "loesung": "LaTeX Lösungsskizze"
      }
    `;

    const result = await model.generateContent([prompt, ...imageParts]);
    const schulaufgabe = JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());

    // LaTeX Template
    const texContent = `
      \\documentclass[a4paper,12pt]{article}
      \\usepackage[utf8]{inputenc}
      \\usepackage[ngerman]{babel}
      \\usepackage{amsmath, amssymb, geometry, fancyhdr, enumitem, graphicx}
      \\geometry{top=25mm, left=25mm, right=25mm, bottom=25mm}
      \\pagestyle{fancy}
      \\lhead{\\textbf{efectoTEC}}
      \\rhead{${escapeLatex(schulaufgabe.fach)} | Kl. ${escapeLatex(schulaufgabe.klasse)}}
      
      \\begin{document}
      \\section*{${escapeLatex(schulaufgabe.titel)}}
      \\textbf{Zeit:} ${schulaufgabe.zeit} \\hfill \\textbf{Hilfsmittel:} ${escapeLatex(schulaufgabe.hilfsmittel)}
      \\hrule \\vspace{0.5cm}
      
      ${schulaufgabe.aufgaben.map((a, i) => `
        \\subsection*{Aufgabe ${i+1} (${a.be} BE)}
        ${a.text}
      `).join('')}

      \\newpage
      \\section*{Lösungen}
      ${escapeLatex(schulaufgabe.loesung)}
      \\end{document}
    `;

    const baseName = `schulaufgabe_${Date.now()}`;
    texFilename = path.join(tempDir, `${baseName}.tex`);
    fs.writeFileSync(texFilename, texContent);

    const cmd = `pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texFilename}"`;
    exec(cmd, (error) => {
      if (error) return res.status(500).send("LaTeX Fehler.");
      pdfFilename = path.join(tempDir, `${baseName}.pdf`);
      res.download(pdfFilename, 'Schulaufgabe.pdf', () => {
        // Cleanup
        try {
             req.files.forEach(f => fs.unlinkSync(f.path));
             fs.unlinkSync(texFilename);
             fs.unlinkSync(pdfFilename);
             const log = path.join(tempDir, `${baseName}.log`);
             if (fs.existsSync(log)) fs.unlinkSync(log);
        } catch(e) {}
      });
    });

  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.use(express.static('public')); // Für CSS/JS falls nötig
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(port, () => console.log(`Server läuft auf ${port}`));