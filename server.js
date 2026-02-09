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

const upload = multer({ dest: uploadDir });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash", 
  generationConfig: { responseMimeType: "application/json", temperature: 0.3 } 
});

function escapeLatex(text) {
  if (typeof text !== 'string') return text || "";
  return text.replace(/\\/g, '').replace(/([&%$#_])/g, '\\$1').replace(/~/g, '\\textasciitilde ').replace(/\^/g, '\\textasciicircum ').replace(/{/g, '\\{').replace(/}/g, '\\}');
}

// 1. STARTSEITE
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. ANALYSE
app.post('/analyze', upload.array('hefteintrag', 3), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.json({}); 

        const imageParts = req.files.map(file => ({
            inlineData: { data: fs.readFileSync(file.path).toString("base64"), mimeType: "image/jpeg" }
        }));

        const prompt = `Analysiere diese Bilder. Identifiziere Fach, Klasse (Zahl), Thema. JSON: { "fach": "...", "klasse": "...", "thema": "..." }`;
        
        const result = await model.generateContent([prompt, ...imageParts]);
        const analysis = JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());
        
        req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        res.json(analysis);
    } catch (err) {
        console.error(err);
        res.json({}); 
    }
});

// 3. GENERIERUNG (MIT FIX)
app.post('/generate', upload.array('hefteintrag', 3), async (req, res) => {
  let texFilename;

  try {
    const { userFach, userKlasse, userThema } = req.body;
    
    let imageParts = [];
    if (req.files && req.files.length > 0) {
        imageParts = req.files.map(file => ({
            inlineData: { data: fs.readFileSync(file.path).toString("base64"), mimeType: "image/jpeg" }
        }));
    }

    const prompt = `
      Rolle: Bayerischer Lehrer (G9). Erstelle Schulaufgabe.
      Fach: ${userFach}, Klasse: ${userKlasse}, Thema: ${userThema}.
      Vorgaben: LaTeX Formeln, LehrplanPLUS Operatoren.
      JSON Output: { "titel": "${userThema}", "aufgaben": [ { "text": "LaTeX", "be": 5 } ], "loesung": "LaTeX" }
    `;

    const result = await model.generateContent([prompt, ...imageParts]);
    const schulaufgabe = JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());

    const texContent = `
      \\documentclass[a4paper,12pt]{article}
      \\usepackage[utf8]{inputenc}
      \\usepackage[ngerman]{babel}
      \\usepackage{amsmath, amssymb, geometry, fancyhdr, enumitem}
      \\geometry{top=25mm, left=25mm, right=25mm, bottom=25mm}
      \\pagestyle{fancy}
      \\lhead{\\textbf{efectoTEC}}
      \\rhead{${escapeLatex(userFach)} | Kl. ${escapeLatex(userKlasse)}}
      \\begin{document}
      \\section*{${escapeLatex(schulaufgabe.titel)}}
      ${schulaufgabe.aufgaben.map((a, i) => `\\subsection*{Aufgabe ${i+1} (${a.be} BE)} ${a.text}`).join('')}
      \\newpage \\section*{Lösungen} ${escapeLatex(schulaufgabe.loesung)}
      \\end{document}
    `;

    const baseName = `schulaufgabe_${Date.now()}`;
    texFilename = path.join(tempDir, `${baseName}.tex`);
    fs.writeFileSync(texFilename, texContent);

    const cmd = `pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texFilename}"`;
    
    // DER FIX: Wir ignorieren den 'error' Parameter erst mal und prüfen, ob das PDF da ist.
    exec(cmd, (error, stdout) => {
      const pdfFilename = path.join(tempDir, `${baseName}.pdf`);
      
      // CHECK: Existiert die Datei?
      if (fs.existsSync(pdfFilename)) {
          // JA -> Senden! (Egal was der Fehlercode sagt)
          res.download(pdfFilename, 'Schulaufgabe.pdf', () => {
            try {
                 if(req.files) req.files.forEach(f => fs.unlinkSync(f.path));
                 [".tex", ".pdf", ".log", ".aux"].forEach(ext => {
                     const f = path.join(tempDir, baseName + ext);
                     if(fs.existsSync(f)) fs.unlinkSync(f);
                 });
            } catch(e) {}
          });
      } else {
          // NEIN -> Dann war es wirklich ein Fehler.
          console.error("LaTeX Fatal Error:", stdout.slice(-300));
          res.status(500).send("LaTeX Fehler (PDF nicht erstellt):\n" + stdout.slice(-300));
      }
    });

  } catch (err) {
    res.status(500).send("Server Fehler: " + err.message);
  }
});

app.listen(port, () => console.log(`Start auf ${port}`));