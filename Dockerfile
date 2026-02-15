# VERWENDUNG: Google Cloud Run Deployment
# VERSION: v1.80-Docker (Support für enumitem/Unteraufgaben)

# 1. Basis-Image: Node.js 20 (Aktueller LTS Standard) auf schlankem Linux
FROM node:20-slim

# 2. System-Pakete & LaTeX Installation
# WICHTIG: 'texlive-latex-extra' ist PFLICHT für das Paket 'enumitem' (Unteraufgaben a, b, c)
# 'texlive-lang-german' sorgt für korrekte Trennung
RUN apt-get update && apt-get install -y \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-lang-german \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

# 3. Arbeitsverzeichnis im Container erstellen
WORKDIR /app

# 4. Abhängigkeiten installieren (Caching-Layer nutzen)
COPY package*.json ./
RUN npm install --only=production

# 5. Restlichen Code kopieren (Server, Assets, HTML)
COPY . .

# 6. Umgebungsvariablen setzen
ENV PORT=8080
ENV NODE_ENV=production

# Port freigeben
EXPOSE 8080

# 7. Server starten
CMD [ "node", "server.js" ]