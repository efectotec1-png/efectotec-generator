const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' }); 
const port = process.env.PORT || 8080; // WICHTIG für Cloud Run!

// --- 1. KI KONFIGURATION (STABLE VERSION) ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Wir nutzen 1.5 Flash, weil es den JSON-Modus perfekt beherrscht.
// Das verhindert Abstürze bei der PDF-Erstellung.
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash", 
  generationConfig: { responseMimeType: "application/json" } 
});

// --- 2. DESIGN-ENGINE (Dein hochwertiges Layout) ---
function createProfessionalLatex(data) {
    const totalBE = data.aufgaben.reduce((acc, curr) => acc + (curr.be || 0), 0);
    const grenzen = {
        1: Math.floor(totalBE * 0.87),
        2: Math.floor(totalBE * 0.73),
        3: Math.floor(totalBE * 0.59),
        4: Math.floor(totalBE * 0.45),
        5: Math.floor(totalBE * 0.18)
    };

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

\\geometry{a4paper, top=25mm, left=20mm, right=20mm, bottom=20mm}

\\pagestyle{fancy}
\\fancyhf{}
\\lhead{\\textbf{efectoTEC} Generator}
\\rhead{Fach: ${data.fach}}
\\rfoot{Seite \\thepage\\ von \\pageref{LastPage}}

\\begin{document}

\\begin{center}
    \\huge \\textbf{${data.titel}}
\\end{center}
\\vspace{0.5cm}

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

${data.aufgaben.map((aufgabe, index) => `
\\section*{Aufgabe ${index + 1} (${aufgabe.be || '?'} BE)}
${aufgabe.text}
`).join('\\vspace{0.5cm}\n')}

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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/generate', upload.single('hefteintrag'), async (req, res) => {
  let imagePath = null;
  let texFilename = null;
  let pdfFilename = null;
  const timestamp = Date.now();

  try {
    console.log("-----------------------------------------");
    console.log("PHASE 1: Bild-Upload empfangen");
    
    if (!req.file) return res.status(400).send("Fehler: Kein Bild hochgeladen.");
    imagePath = req.file.path;

    // A. KI-Verarbeitung
    console.log("PHASE 2: Sende an Gemini 1.5 Flash...");
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
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const schulaufgabe = JSON.parse(cleanJson);
    console.log(`   -> KI Generierung erfolgreich: "${schulaufgabe.titel}"`);

    // B. LaTeX
    console.log("PHASE 3: Erzeuge LaTeX...");
    const texContent = createProfessionalLatex(schulaufgabe);
    texFilename = path.resolve(__dirname, `schulaufgabe_${timestamp}.tex`);
    pdfFilename = path.resolve(__dirname, `schulaufgabe_${timestamp}.pdf`);
    fs.writeFileSync(texFilename, texContent);

    // C. PDF Engine
    console.log("PHASE 4: Starte PDF-Engine...");
    const dir = path.dirname(texFilename);
    const base = path.basename(texFilename);

    exec(`pdflatex -interaction=nonstopmode -output-directory="${dir}" "${base}"`, (error, stdout, stderr) => {
      if (error) {
        console.error("!!! FEHLER BEI PDF-ERSTELLUNG !!!", stdout.slice(-200));
        return res.status(500).send("Server-Fehler: PDF konnte nicht erstellt werden. Logs prüfen.");
      }
      
      console.log("PHASE 5: PDF fertig. Sende an Client.");
      res.download(pdfFilename, `efectoTEC_Probe_${timestamp}.pdf`, (err) => {
        // Cleanup
        if (fs.existsSync(texFilename)) fs.unlinkSync(texFilename);
        if (fs.existsSync(pdfFilename)) fs.unlinkSync(pdfFilename);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
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
  console.log(`efectoTEC Server läuft auf Port ${port}`);
});