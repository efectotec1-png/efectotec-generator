const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
// Upload-Speicherort konfigurieren
const upload = multer({ dest: 'uploads/' }); 
const port = process.env.PORT || 3000;

// --- 1. KI KONFIGURATION ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Upgrade auf Flash 2.0 für Speed & Qualität (entsprechend Umsetzungsbericht)
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.0-flash", 
  generationConfig: { responseMimeType: "application/json" } 
});

// --- 2. DIE DESIGN-ENGINE (ehemals tex-generator.js) ---
function createProfessionalLatex(data) {
    // A. Gesamt-BE (Punkte) berechnen für den Notenschlüssel
    const totalBE = data.aufgaben.reduce((acc, curr) => acc + (curr.be || 0), 0);

    // B. Notenschlüssel berechnen (Bayerischer Standard-Algorithmus)
    const grenzen = {
        1: Math.floor(totalBE * 0.87),
        2: Math.floor(totalBE * 0.73),
        3: Math.floor(totalBE * 0.59),
        4: Math.floor(totalBE * 0.45),
        5: Math.floor(totalBE * 0.18)
    };

    // C. Das LaTeX-Template zusammenbauen
    // Hier nutzen wir Packages für professionelles Layout (fancyhdr, tabularx)
    return `
\\documentclass[a4paper,12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[ngerman]{babel}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{geometry}
\\usepackage{fancyhdr}
\\usepackage{tabularx}
\\usepackage{graphicx}
\\usepackage{lastpage}

% Seitenränder analog DIN 5008 Annäherung
\\geometry{a4paper, top=25mm, left=20mm, right=20mm, bottom=20mm}

% Kopfzeile mit Branding
\\pagestyle{fancy}
\\fancyhf{}
\\lhead{\\textbf{efectoTEC} Generator}
\\rhead{Fach: ${data.fach}}
\\rfoot{Seite \\thepage\\ von \\pageref{LastPage}}

\\begin{document}

% --- TITELBEREICH ---
\\begin{center}
    \\huge \\textbf{${data.titel}}
\\end{center}
\\vspace{0.5cm}

% --- SCHÜLERDATEN & NOTENSCHLÜSSEL ---
\\noindent
\\textbf{Name:} \\underline{\\hspace{6cm}} \\hfill \\textbf{Datum:} \\today \\\\[0.5cm]

\\begin{table}[h]
    \\centering
    \\small
    \\begin{tabularx}{\\textwidth}{|X|c|c|c|c|c|c|}
        \\hline
        \\textbf{Notenschlüssel} & 1 & 2 & 3 & 4 & 5 & 6 \\\\
        \\hline
        \\textbf{Punkte ab} & ${grenzen[1]} & ${grenzen[2]} & ${grenzen[3]} & ${grenzen[4]} & ${grenzen[5]} & 0 \\\\
        \\hline
    \\end{tabularx}
\\end{table}

\\vspace{0.5cm}
\\noindent
\\textbf{Gesamtpunktzahl:} ${totalBE} BE

\\vspace{1cm}
\\hrule
\\vspace{1cm}

% --- AUFGABENTEIL ---
${data.aufgaben.map((aufgabe, index) => `
\\section*{Aufgabe ${index + 1} (${aufgabe.be || '?'} BE)}
${aufgabe.text}
`).join('\\vspace{0.5cm}\n')}

% --- LÖSUNGSBLATT (Neue Seite) ---
\\newpage
\\fancyhead[L]{Lösungsschlüssel (Nur für Lehrkräfte)}
\\section*{Lösungen}

${data.aufgaben.map((aufgabe, index) => `
\\subsection*{Zu Aufgabe ${index + 1}:}
${aufgabe.loesung}
`).join('\n')}

\\end{document}
    `;
}

// --- 3. ROUTEN ---

// Startseite
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Hauptprozess: Upload -> KI -> LaTeX -> PDF
app.post('/generate', upload.single('hefteintrag'), async (req, res) => {
  let imagePath = null;
  let texFilename = null;
  let pdfFilename = null;
  const timestamp = Date.now();

  try {
    console.log("-----------------------------------------");
    console.log("PHASE 1: Bild-Upload empfangen");
    
    if (!req.file) {
      return res.status(400).send("Fehler: Kein Bild hochgeladen.");
    }
    imagePath = req.file.path;

    // A. KI-Verarbeitung
    console.log("PHASE 2: Sende an Gemini AI...");
    const imageBuffer = fs.readFileSync(imagePath);
    const imagePart = {
      inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" }
    };

    const prompt = `
      Du bist ein bayerischer Gymnasiallehrer.
      Erstelle aus diesem Hefteintrag eine Schulaufgabe (Prüfung).
      
      Regeln:
      1. Nutze LaTeX für Formeln (z.B. $x^2$).
      2. Erstelle eine Mischung aus Rechenaufgaben und Verständnisfragen (AFB I-III).
      3. Sei streng aber fair bei den BE (Bewertungseinheiten).
      
      Antworte NUR mit validem JSON:
      {
        "titel": "Thema",
        "fach": "Fach",
        "aufgaben": [
          { "text": "LaTeX Aufgabe", "be": 5, "loesung": "LaTeX Lösung" }
        ]
      }
    `;

    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();
    
    // JSON Cleaning (entfernt Markdown ```json Blöcke)
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const schulaufgabe = JSON.parse(cleanJson);
    console.log(`   -> KI Generierung erfolgreich: "${schulaufgabe.titel}"`);

    // B. LaTeX Generierung (Mit dem neuen Design)
    console.log("PHASE 3: Erzeuge professionelles LaTeX-Layout...");
    const texContent = createProfessionalLatex(schulaufgabe);
    
    // Wir nutzen absolute Pfade, um Fehler zu vermeiden
    texFilename = path.resolve(__dirname, `schulaufgabe_${timestamp}.tex`);
    pdfFilename = path.resolve(__dirname, `schulaufgabe_${timestamp}.pdf`);
    
    fs.writeFileSync(texFilename, texContent);

    // C. PDF Engine (pdflatex)
    console.log("PHASE 4: Starte PDF-Engine (lokal)...");
    const dir = path.dirname(texFilename);
    const base = path.basename(texFilename);

    // WICHTIG: Hier scheitert es, wenn kein MiKTeX da ist.
    // Wir fangen den Fehler sauber ab.
    exec(`pdflatex -interaction=nonstopmode -output-directory="${dir}" "${base}"`, (error, stdout, stderr) => {
      if (error) {
        console.error("!!! FEHLER BEI PDF-ERSTELLUNG !!!");
        console.error("Ursache: Wahrscheinlich ist kein 'pdflatex' installiert oder nicht im PATH.");
        console.error("Details:", stdout.slice(-200)); // Letzte 200 Zeichen des Logs
        return res.status(500).send(`
          <h1>Server-Fehler: PDF-Engine nicht gefunden</h1>
          <p>Der Server konnte das PDF nicht bauen. Das liegt meist daran, dass auf dem Host-Computer kein LaTeX (MiKTeX/TeXLive) installiert ist.</p>
          <p><b>Für den Admin:</b> Bitte Phase 2 (Docker) einleiten oder MiKTeX prüfen.</p>
          <pre>${error.message}</pre>
        `);
      }
      
      console.log("PHASE 5: PDF fertig. Sende an Client.");
      res.download(pdfFilename, `efectoTEC_Probe_${timestamp}.pdf`, (err) => {
        // CLEANUP (Datenschutz)
        if (fs.existsSync(texFilename)) fs.unlinkSync(texFilename);
        if (fs.existsSync(pdfFilename)) fs.unlinkSync(pdfFilename);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        // Aufräumen der LaTeX Hilfsdateien (.log, .aux)
        const logFile = texFilename.replace('.tex', '.log');
        const auxFile = texFilename.replace('.tex', '.aux');
        if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        if (fs.existsSync(auxFile)) fs.unlinkSync(auxFile);
      });
    });

  } catch (err) {
    console.error("KRITISCHER FEHLER:", err);
    if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    res.status(500).send("Systemfehler: " + err.message);
  }
});

app.listen(port, () => {
  console.log(`\n=========================================`);
  console.log(`   efectoTEC PROTOTYP: READY`);
  console.log(`   Port: ${port}`);
  console.log(`   Design-Modus: PROFESSIONAL`);
  console.log(`=========================================\n`);
});