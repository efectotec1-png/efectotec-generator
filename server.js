const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require('child_process');
const path = require('path');
const os = require('os'); // Wichtig für Temp-Ordner Zugriff
require('dotenv').config();

const app = express();

// --- FEHLER-FIX 1: PORT ---
// Wir nutzen den Port, den Google uns gibt (meist 8080). 
// Nur wenn keiner da ist, nehmen wir 3000 (für deinen PC).
const port = process.env.PORT || 8080;

// --- FEHLER-FIX 2: SCHREIBRECHTE ---
// In der Cloud dürfen wir NUR in das temporäre Verzeichnis schreiben.
// os.tmpdir() findet automatisch den richtigen Ort (z.B. /tmp).
const tempDir = os.tmpdir(); 
const uploadDir = path.join(tempDir, 'efectotec_uploads');

// Wir erstellen den Ordner sicher im Temp-Verzeichnis
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer speichert Bilder jetzt im erlaubten Temp-Ordner
const upload = multer({ dest: uploadDir });

// --- CONFIG ---
const MODEL_NAME = process.env.MODEL_NAME || "gemini-2.5-flash";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: MODEL_NAME, 
  generationConfig: { responseMimeType: "application/json", temperature: 0.2 } 
});

// --- HELPER: Sonderzeichen maskieren ---
function escapeLatex(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\\/g, '') 
    .replace(/([&%$#_])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde ')
    .replace(/\^/g, '\\textasciicircum ');
}

// --- ROUTEN ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/generate', upload.single('hefteintrag'), async (req, res) => {
  let texFilename = null;
  let pdfFilename = null;
  let imagePath = null;

  try {
    console.log("\n--- NEUE ANFRAGE (CLOUD) ---");
    
    if (!req.file) return res.status(400).send("Fehler: Kein Bild hochgeladen.");
    
    imagePath = req.file.path;
    const imageBuffer = fs.readFileSync(imagePath);
    const imagePart = { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } };

    console.log("-> Frage KI (2.5 Flash)...");
    
    const prompt = `
      Rolle: Bayerischer Gymnasiallehrer.
      Aufgabe: Erstelle eine Schulaufgabe (Mathe) aus diesem Bild.
      
      FORMATIERUNG:
      1. Nutze LaTeX für Formeln ($x^2$).
      2. WICHTIG: Nutze für Aufzählungen (a, b, c) die LaTeX-Umgebung 'enumerate'.
      
      JSON Output: { "titel": "...", "fach": "...", "aufgaben": [...] }
    `;

    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();
    const cleanedText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const schulaufgabe = JSON.parse(cleanedText);

    console.log(`-> Generiert: ${schulaufgabe.titel}`);
    
    // LaTeX Datei erstellen
    const texContent = `
      \\documentclass[a4paper,12pt]{article}
      \\usepackage[utf8]{inputenc}
      \\usepackage[ngerman]{babel}
      \\usepackage{amsmath}
      \\usepackage{amssymb}
      \\usepackage{fancyhdr}
      \\usepackage{geometry}
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
    
    // WICHTIG: Wir schreiben die .tex Datei auch nach /tmp
    const baseName = `schulaufgabe_${Date.now()}`;
    texFilename = path.join(tempDir, `${baseName}.tex`);
    fs.writeFileSync(texFilename, texContent);

    console.log("-> Starte PDF-Druck...");
    
    // WICHTIG: Wir sagen pdflatex, dass es im /tmp Ordner arbeiten soll (-output-directory)
    const cmd = `pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texFilename}"`;
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("PDF FEHLER:", stdout.slice(-200));
        return res.status(500).send("Fehler beim PDF Druck.");
      }
      
      pdfFilename = path.join(tempDir, `${baseName}.pdf`);
      console.log("-> Sende PDF...");
      
      res.download(pdfFilename, (err) => {
         // Aufräumen
         try {
             if (fs.existsSync(texFilename)) fs.unlinkSync(texFilename);
             if (fs.existsSync(pdfFilename)) fs.unlinkSync(pdfFilename);
             if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
         } catch(e) {}
      });
    });

  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).send("Server Fehler: " + err.message);
  }
});

app.listen(port, () => {
  console.log(`efectoTEC Server läuft auf Port ${port}`);
});