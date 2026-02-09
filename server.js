const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require('child_process');
const path = require('path');
const os = require('os'); // ZWINGEND für Cloud Run
require('dotenv').config();

const app = express();

// --- 1. CLOUD RUN CONFIG ---
// Google Cloud weist dynamisch einen Port zu (meist 8080).
const port = process.env.PORT || 8080;

// WICHTIG: In Cloud Run (Serverless) dürfen wir nur nach /tmp schreiben.
// Alle anderen Ordner sind Read-Only!
const tempDir = os.tmpdir(); 
const uploadDir = path.join(tempDir, 'efectotec_uploads');

// Erstelle den Upload-Ordner im temporären Verzeichnis, falls nicht vorhanden
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer konfiguieren: Speicherort ist das tempDir
const upload = multer({ dest: uploadDir });

// --- 2. KI KONFIGURATION ---
const MODEL_NAME = "gemini-2.5-flash"; // Das effizienteste Modell
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: MODEL_NAME, 
  generationConfig: { responseMimeType: "application/json", temperature: 0.2 } 
});

// Helper: LaTeX Cleaning für Sicherheit
function escapeLatex(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\\/g, '') 
    .replace(/([&%$#_])/g, '\\$1') // Maskiert Sonderzeichen, die LaTeX crashen lassen
    .replace(/~/g, '\\textasciitilde ')
    .replace(/\^/g, '\\textasciicircum ');
}

// --- 3. ROUTEN ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/generate', upload.single('hefteintrag'), async (req, res) => {
  // Wir definieren die Pfade hier, damit wir sie im 'finally' Block aufräumen können
  let texFilename = null;
  let pdfFilename = null;
  let imagePath = null;

  try {
    console.log("-----------------------------------------");
    console.log(`NEUE ANFRAGE (Modell: ${MODEL_NAME})`);
    
    if (!req.file) {
      return res.status(400).send("Fehler: Kein Bild hochgeladen.");
    }

    // A) Bild einlesen
    imagePath = req.file.path;
    const imageBuffer = fs.readFileSync(imagePath);
    const imagePart = {
      inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" }
    };

    // B) Prompting
    const prompt = `
      Rolle: Bayerischer Gymnasiallehrer (G9).
      Aufgabe: Erstelle eine Schulaufgabe aus diesem Bild.
      
      REGELN:
      1. Ausgabe MUSS valides JSON sein.
      2. Nutze LaTeX für Formeln (z.B. $x^2$).
      3. Nutze die 'enumerate'-Umgebung für Teilaufgaben (a, b).
      
      JSON SCHEMA:
      {
        "titel": "Thema der Probe",
        "fach": "Mathematik",
        "aufgaben": [
          { "text": "Aufgabentext in LaTeX", "be": 4, "loesung": "Lösungsweg" }
        ]
      }
    `;

    console.log("-> Sende an Gemini...");
    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();
    
    // JSON Cleaning (falls Markdown-Blöcke ```json dabei sind)
    const cleanedText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const schulaufgabe = JSON.parse(cleanedText);
    
    console.log("-> Generiert: " + schulaufgabe.titel);

    // C) LaTeX Template bauen
    const texContent = `
      \\documentclass[a4paper,12pt]{article}
      \\usepackage[utf8]{inputenc}
      \\usepackage[ngerman]{babel}
      \\usepackage{amsmath}
      \\usepackage{amssymb}
      \\usepackage{geometry}
      \\usepackage{fancyhdr}
      \\usepackage{enumitem} 
      
      \\geometry{a4paper, top=25mm, left=25mm, right=25mm, bottom=25mm}
      \\pagestyle{fancy}
      \\lhead{\\textbf{efectoTEC}}
      \\rhead{Fach: ${escapeLatex(schulaufgabe.fach)}}
      
      \\begin{document}
      \\section*{${escapeLatex(schulaufgabe.titel)}}
      
      ${schulaufgabe.aufgaben.map((a, i) => `
        \\subsection*{Aufgabe ${i+1} (${a.be} BE)}
        ${a.text}
      `).join('')}
      
      \\end{document}
    `;

    // D) Speichern in /tmp (WICHTIG für Cloud Run)
    const baseName = `schulaufgabe_${Date.now()}`;
    texFilename = path.join(tempDir, `${baseName}.tex`);
    fs.writeFileSync(texFilename, texContent);

    // E) PDF Generierung
    console.log("-> Starte pdflatex...");
    // Wir sagen pdflatex explizit: Schreibe den Output nach tempDir!
    const cmd = `pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texFilename}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("Fehler beim PDF-Druck:", stdout.slice(-500)); // Letzte 500 Zeichen Log
        return res.status(500).send("Fehler beim PDF-Erstellen. Logs prüfen.");
      }
      
      pdfFilename = path.join(tempDir, `${baseName}.pdf`);
      console.log("-> PDF fertig: " + pdfFilename);
      
      res.download(pdfFilename, 'Dein_Schulaufgabe.pdf', (err) => {
        // Aufräumen (Clean-Up Routine)
        try {
            if (fs.existsSync(texFilename)) fs.unlinkSync(texFilename);
            if (fs.existsSync(pdfFilename)) fs.unlinkSync(pdfFilename);
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
            // Auch Hilfsdateien löschen (.log, .aux)
            const logFile = path.join(tempDir, `${baseName}.log`);
            const auxFile = path.join(tempDir, `${baseName}.aux`);
            if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
            if (fs.existsSync(auxFile)) fs.unlinkSync(auxFile);
        } catch (cleanupErr) {
            console.error("Cleanup Error:", cleanupErr);
        }
      });
    });

  } catch (err) {
    console.error("CRITICAL ERROR:", err);
    res.status(500).send("Server Fehler: " + err.message);
  }
});

app.listen(port, () => {
  console.log(`\n=========================================`);
  console.log(`   efectoTEC SERVER LÄUFT (Port ${port})`);
  console.log(`=========================================\n`);
});