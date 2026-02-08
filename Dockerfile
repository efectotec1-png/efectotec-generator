# 1. Wir starten mit einem leichten Node.js System (Linux)
FROM node:18-slim

# 2. INSTALLATION VON LATEX (Der kritische Teil)
# Wir aktualisieren das System und installieren nur das Nötigste für PDF-Erstellung.
# - texlive-latex-base: Der Kern
# - texlive-lang-german: Für deutsche Silbentrennung (babel)
# - texlive-latex-extra: Enthält 'fancyhdr', 'tabularx', 'lastpage' (WICHTIG für dein Design!)
# - texlive-fonts-recommended: Standardschriften
RUN apt-get update && apt-get install -y \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-lang-german \
    texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/*

# 3. Arbeitsverzeichnis im Container erstellen
WORKDIR /app

# 4. Abhängigkeiten kopieren und installieren
# Wir kopieren erst nur package.json, damit Docker diesen Schritt cachen kann (schnellerer Build)
COPY package.json ./
RUN npm install

# 5. Den restlichen Code kopieren
COPY . .

# 6. Port freigeben (Google Cloud Run erwartet Port 8080 als Standard, wir nutzen ENV)
ENV PORT=8080
EXPOSE 8080

# 7. Startbefehl
CMD [ "node", "server.js" ]