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

// --- WICHTIG: SETUP FÜR CLOUD RUN ---
const tempDir = os.tmpdir();
const uploadDir = path.join(tempDir, 'efectotec_uploads');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

// KI Config
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash", 
  generationConfig: { responseMimeType: "application/json", temperature: 0.3 } 
});

// Helper
function escapeLatex(text) {
  if (typeof text !== 'string') return text || "";
  return text.replace(/\\/g, '').replace(/([&%$#_])/g, '\\$1').replace(/~/g, '\\textasciitilde ').replace(/\^/g, '\\textasciicircum ').replace(/{/g, '\\{').replace(/}/g, '\\}');
}

// ==========================================
// 1. DIE STARSEITE (DER FIX FÜR "CANNOT GET /")
// ==========================================
app.get('/', (req, res) => {
    // Wir senden explizit die index.html aus dem aktuellen Ordner
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Optional: Statische Dateien (falls wir später CSS auslagern)
app.use(express.static(path.join(__dirname, 'public')));


// ==========================================
// 2. API ROUTEN
// ==========================================

// --- ROUTE: ANALYSE ---
app.post('/analyze', upload.array('hefteintrag', 3), async (req, res) => {
    try {
        console.log("Analyse gestartet...");
        if (!req.files || req.files.length === 0) return res.json({}); 

        const imageParts = req.files.map(file => ({
            inlineData: { data: fs.readFileSync(file.path).toString("base64"), mimeType: "image/jpeg" }
        }));

        const prompt = `
            Analysiere diese Schulmaterialien.
            Identifiziere Fach, Klasse und Thema.
            Antworte NUR mit JSON:
            { "fach": "...", "klasse": "...", "thema": "..." }
        `;

        const result = await model.generateContent([prompt, ...imageParts]);
        const analysis = JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());
        
        // Cleanup
        req.files.forEach(f => { try { fs.unlinkSync(f.path) } catch(e){} });
        res.json(analysis);

    } catch (err) {
        console.error("Analyse Fehler:", err);
        res.json({}); // Leeres JSON bei Fehler, damit Frontend nicht crasht
    }
});

// --- ROUTE: GENERIERUNG ---
app.post('/generate', upload.array('hefteintrag', 3), async (req, res) => {
  let texFilename;
  console.log("Generierung gestartet...");

  try {
    const { userFach, userKlasse, userThema } = req.body;
    
    let imageParts = [];
    if (req.files && req.files.length > 0) {
        imageParts = req.files.map(file => ({
            inlineData: { data: fs.readFileSync(file.path).toString("base64"), mimeType: "image/jpeg" }
        }));
    }

    const prompt = `
      Rolle: Bayerischer Lehrer (G9).
      Erstelle eine Schulaufgabe.
      Fach: ${userFach}, Klasse: ${userKlasse}, Thema: ${userThema}.
      
      VORGABEN:
      1. LaTeX für Formeln. KEIN Markdown im LaTeX-Code.
      2. Operatoren nach LehrplanPLUS.
      
      JSON OUTPUT:
      {
        "titel": "${userThema}",
        "aufgaben": [ { "text": "LaTeX Code", "be": 5 } ],
        "loesung": "Lösungsskizze LaTeX"
      }
    `;

    const result = await model.generateContent([prompt, ...imageParts]);
    const cleanJson = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    const schulaufgabe = JSON.parse(cleanJson);

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
      
      ${schulaufgabe.aufgaben.map((a, i) => `
        \\subsection*{Aufgabe ${i+1} (${a.be} BE)}
        ${a.text}
      `).join('')}

      \\newpage
      \\section*{Lösungen (Lehrkraft)}
      ${escapeLatex(schulaufgabe.loesung)}
      \\end{document}
    `;

    const baseName = `schulaufgabe_${Date.now()}`;
    texFilename = path.join(tempDir, `${baseName}.tex`);
    fs.writeFileSync(texFilename, texContent);

    const cmd = `pdflatex -interaction=nonstopmode -output-directory="${tempDir}" "${texFilename}"`;
    
    exec(cmd, (error, stdout) => {
      if (error) {
        console.error("LaTeX Fehler:", stdout.slice(-300));
        return res.status(500).send("LaTeX Fehler:\n" + stdout.slice(-300));
      }
      
      const pdfFilename = path.join(tempDir, `${baseName}.pdf`);
      res.download(pdfFilename, 'Schulaufgabe.pdf', () => {
        try {
             if(req.files) req.files.forEach(f => fs.unlinkSync(f.path));
             const exts = [".tex", ".pdf", ".log", ".aux"];
             exts.forEach(ext => {
                 const f = path.join(tempDir, baseName + ext);
                 if(fs.existsSync(f)) fs.unlinkSync(f);
             });
        } catch(e) {}
      });
    });

  } catch (err) {
    console.error("Server Crash:", err);
    res.status(500).send("Server Fehler: " + err.message);
  }
});

app.listen(port, () => console.log(`Start auf Port ${port}`));