const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
// Upload-Ordner konfigurieren
const upload = multer({ dest: 'uploads/' }); 
const port = 3000;

// --- 1. KI KONFIGURATION (STRATEGIE-WECHSEL) ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// UPDATE NACH CTO-ENTSCHEIDUNG:
// Wir nutzen "Gemini 3.0" (High-Reasoning).
// Priorität: Didaktische Qualität > Geschwindigkeit.
// Die Eltern warten lieber 5 Sekunden länger für eine perfekte Aufgabe.
const model = genAI.getGenerativeModel({ 
  model: "gemini-3.0", 
  generationConfig: { 
    responseMimeType: "application/json",
    // Wir erlauben dem Modell etwas mehr "Kreativität" für Transferaufgaben
    temperature: 0.4 
  } 
});

// --- 2. STARTSEITE ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 3. HAUPT-PROZESS (POST /generate) ---
app.post('/generate', upload.single('hefteintrag'), async (req, res) => {
  try {
    console.log("-----------------------------------------");
    console.log("NEUE ANFRAGE (Modell: Gemini 3.0 High-Res)");
    
    if (!req.file) {
      return res.status(400).send("Fehler: Kein Bild hochgeladen.");
    }

    // SCHRITT A: Bild vorbereiten
    console.log("A) Lese Bild ein...");
    const imagePath = req.file.path;
    const imageBuffer = fs.readFileSync(imagePath);
    const imagePart = {
      inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" }
    };

    // SCHRITT B: Prompting (Optimiert für Gemini 3.0 Reasoning)
    console.log("B) Sende an Gemini 3.0 (Das kann kurz dauern, Quality First!)...");
    
    const prompt = `
      Rolle: Erfahrener Gymnasiallehrer in Bayern (G9).
      Aufgabe: Erstelle eine Schulaufgabe basierend auf diesem Hefteintrag.
      
      Anforderungen an die Didaktik (WICHTIG):
      1. Nutze die Operatoren des bayerischen Lehrplans (Nenne, Beschreibe, Erläutere, Berechne).
      2. Erstelle Aufgaben in den Anforderungsbereichen I (Reproduktion), II (Reorganisation) und III (Transfer/Urteil).
      3. Sei präzise bei mathematischen Notation (LaTeX).
      
      Output-Format (Reines JSON):
      {
        "titel": "Titel der Probe",
        "fach": "Mathematik (oder erkanntes Fach)",
        "aufgaben": [
          { "text": "Aufgabentext mit LaTeX Formeln wie $x^2$", "be": 4, "loesung": "Lösungsweg in LaTeX" },
          { "text": "Transferaufgabe...", "be": 6, "loesung": "..." }
        ]
      }
    `;

    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();
    
    // Safety-Cleaning für JSON (falls das Modell "```json" davor schreibt)
    const cleanedText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    let schulaufgabe;
    try {
        schulaufgabe = JSON.parse(cleanedText);
    } catch (e) {
        console.error("JSON Parsing Fehler (Raw Text):", responseText);
        throw new Error("Das Modell hat kein valides JSON geliefert. Bitte versuche es erneut.");
    }

    console.log(`   -> Generiert: "${schulaufgabe.titel}" mit ${schulaufgabe.aufgaben.length} Aufgaben.`);
    
    // SCHRITT C: LaTeX Generierung
    console.log("C) Baue LaTeX-Dokument...");
    const texContent = `
      \\documentclass[a4paper,12pt]{article}
      \\usepackage[utf8]{inputenc}
      \\usepackage[ngerman]{babel}
      \\usepackage{geometry}
      \\geometry{a4paper, top=25mm, left=25mm, right=25mm, bottom=25mm}
      \\usepackage{amsmath}
      \\usepackage{amssymb}
      \\usepackage{fancyhdr}
      
      \\pagestyle{fancy}
      \\lhead{\\textbf{efectoTEC} - Lernzielkontrolle}
      \\rhead{Fach: ${schulaufgabe.fach}}
      
      \\begin{document}
      
      \\section*{${schulaufgabe.titel}}
      \\textbf{Datum:} \\today \\hfill \\textbf{Name:} \\underline{\\hspace{5cm}}
      \\vspace{0.5cm}
      \\hrule
      \\vspace{1cm}
      
      ${schulaufgabe.aufgaben.map((a, i) => `
        \\subsection*{Aufgabe ${i+1} (${a.be} BE)}
        ${a.text}
      `).join('')}
      
      \\vspace{2cm}
      \\begin{center}
      \\small \\textit{Erstellt mit Gemini 3.0 & efectoTEC}
      \\end{center}
      
      \\newpage
      \\section*{Lösungsschlüssel}
      ${schulaufgabe.aufgaben.map((a, i) => `
        \\textbf{Zu Aufgabe ${i+1}:} ${a.loesung} \\par
      `).join('\n')}

      \\end{document}
    `;
    
    const texFilename = `schulaufgabe_${Date.now()}.tex`;
    fs.writeFileSync(texFilename, texContent);

    // SCHRITT D: PDF Erstellung
    console.log("D) PDF wird erstellt...");
    exec(`pdflatex -interaction=nonstopmode ${texFilename}`, (error, stdout, stderr) => {
      if (error) {
        console.error("Fehler beim PDF-Druck:", error);
        return res.status(500).send("Fehler bei der PDF-Erstellung. Ist pdflatex installiert?");
      }
      
      console.log("E) Erfolg! Sende PDF.");
      const pdfFilename = texFilename.replace('.tex', '.pdf');
      
      res.download(pdfFilename, `Schulaufgabe_${Date.now()}.pdf`, (err) => {
        // Aufräumen (Datenschutz: Alles sofort löschen!)
        if (!err) {
             try {
                fs.unlinkSync(texFilename); 
                fs.unlinkSync(pdfFilename);
                fs.unlinkSync(imagePath); // WICHTIG: Originalbild löschen
                // Logfiles aufräumen
                if(fs.existsSync(texFilename.replace('.tex', '.log'))) fs.unlinkSync(texFilename.replace('.tex', '.log'));
                if(fs.existsSync(texFilename.replace('.tex', '.aux'))) fs.unlinkSync(texFilename.replace('.tex', '.aux'));
             } catch(e) {
                 console.error("Cleanup Warning:", e);
             }
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
  console.log(`   efectoTEC SERVER (GEMINI 3.0 MODE)`);
  console.log(`   Running on: http://localhost:${port}`);
  console.log(`=========================================\n`);
});