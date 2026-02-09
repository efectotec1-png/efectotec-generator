# 1. Wir starten mit einem leichten Node.js System (Linux)
FROM node:18-slim

# 2. INSTALLATION VON LATEX
# UPDATE: 'texlive-latex-recommended' hinzugefügt für das Paket 'geometry'!
RUN apt-get update && apt-get install -y \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-lang-german \
    texlive-latex-recommended \
    texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/*

# 3. Arbeitsverzeichnis
WORKDIR /app

# 4. Abhängigkeiten (Caching nutzen)
COPY package.json ./
RUN npm install

# 5. Code kopieren
COPY . .

# 6. Port Config (Standard für Cloud Run)
ENV PORT=8080
EXPOSE 8080

# 7. Startbefehl
CMD [ "node", "server.js" ]