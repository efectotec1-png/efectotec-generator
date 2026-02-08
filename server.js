const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' }); 
const port = 3000;

// --- CONFIG ---
const MODEL_NAME = process.env.MODEL_NAME || "gemini-2.5-flash";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: MODEL_NAME, 
  generationConfig: { responseMimeType: "application/json", temperature: 0.2 } 
});

// --- HELPER: LaTeX Zeichen entschärfen ---
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
    console.log("\n-----------------------------------------");
    console.log("NEUE ANFRAGE STARTET");
    console.log(`Modell: ${MODEL_NAME}`);

    if (!req.file) return res.status(400).send("Kein Bild hochgeladen.");
    
    imagePath = req.file.path;
    const imageBuffer = fs.readFileSync(imagePath);
    const imagePart = { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } };

    console.log("-> Frage KI (Bitte warten)...");
    
    // --- UPDATE: Besserer Prompt für Listen ---
    const prompt = `
      Rolle: Bayerischer Gymnasiallehrer.
      Aufgabe: Erstelle eine Schulaufgabe aus diesem Bild.
      
      FORMATIERUNG (WICHTIG):
      1. Nutze für Mathe-Formeln LaTeX-Code (z.B. $x^2$).
      2. Wenn eine Aufgabe Unterpunkte hat (a, b, c), nutze ZWINGEND die LaTeX 'enumerate' Umgebung.
         Beispiel für den JSON-Text: 
         "Berechne folgendes: \\begin{enumerate}[label=\\alph*)] \\item Bestimme x. \\item Bestimme y. \\end{enumerate}"
      
      Antworte als JSON:
      {
        "titel": "Thema",
        "fach": "Fach",
        "aufgaben": [ { "text": "Frage mit itemize", "be": 5, "loesung": "Lösung" } ]
      }
    `;

    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();
    const cleanedText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    let schulaufgabe;
    try {
        schulaufgabe = JSON.parse(cleanedText);
    } catch (e) {
        throw new Error("KI hat kein gültiges JSON geliefert.");
    }

    console.log(`-> Generiert: "${schulaufgabe.titel}"`);
    
    console.log("-> Erstelle LaTeX Code...");
    
    // --- UPDATE: enumitem Paket hinzugefügt ---
    const texContent = `
      \\documentclass[a4paper,12pt]{article}
      \\usepackage[utf8]{inputenc}
      \\usepackage[ngerman]{babel}
      \\usepackage{amsmath}
      \\usepackage{amssymb}
      \\usepackage{fancyhdr}
      \\usepackage{geometry}
      \\usepackage{enumitem} % WICHTIG für a) b) c) Listen
      \\geometry{a4paper, top=25mm, left=25mm, right=25mm, bottom=25mm}
      
      \\pagestyle{fancy}
      \\lhead{\\textbf{efectoTEC}}
      \\rhead{Fach: ${escapeLatex(schulaufgabe.fach)}}
      
      \\begin{document}
      \\section*{${escapeLatex(schulaufgabe.titel)}}
      \\textbf{Datum:} \\today \\hfill \\textbf{Name:} \\underline{\\hspace{5cm}}
      \\vspace{1cm}
      
      ${schulaufgabe.aufgaben.map((a, i) => `
        \\subsection*{Aufgabe ${i+1} (${a.be} BE)}
        ${a.text}
      `).join('')}
      
      \\vspace{2cm}
      \\hrule
      \\vspace{0.5cm}
      \\section*{Lösungsschlüssel}
      ${schulaufgabe.aufgaben.map((a, i) => `
        \\textbf{Aufgabe ${i+1}:} ${a.loesung} \\par
        \\vspace{0.2cm}
      `).join('\n')}
      \\end{document}
    `;
    
    texFilename = `schulaufgabe_${Date.now()}.tex`;
    fs.writeFileSync(texFilename, texContent);

    console.log("-> Starte PDF-Druck (pdflatex)...");
    
    exec(`pdflatex -interaction=nonstopmode ${texFilename}`, (error, stdout, stderr) => {
      if (error) {
        console.error("!!! PDF FEHLER !!!");
        console.error(stdout.slice(-500)); 
        return res.status(500).send("Fehler beim PDF-Erstellen.");
      }
      
      console.log("-> ERFOLG! PDF wird gesendet.");
      pdfFilename = texFilename.replace('.tex', '.pdf');
      
      res.download(pdfFilename, (err) => {
        if (texFilename && fs.existsSync(texFilename)) fs.unlinkSync(texFilename);
        if (pdfFilename && fs.existsSync(pdfFilename)) fs.unlinkSync(pdfFilename);
        if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        const logFile = texFilename.replace('.tex', '.log');
        const auxFile = texFilename.replace('.tex', '.aux');
        if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        if (fs.existsSync(auxFile)) fs.unlinkSync(auxFile);
      });
    });

  } catch (err) {
    console.error("CRITICAL ERROR:", err);
    res.status(500).send("Server Fehler: " + err.message);
    if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
  }
});

app.listen(port, () => {
  console.log(`efectoTEC SERVER LÄUFT (Modell: ${MODEL_NAME})`);
});