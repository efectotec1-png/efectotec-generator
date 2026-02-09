# 1. Basis-Image
FROM node:18-slim

# 2. LaTeX Installation (Inklusive Tabellen-Paketen für deinen Footer)
RUN apt-get update && apt-get install -y \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-lang-german \
    texlive-latex-recommended \
    texlive-fonts-recommended \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

# 3. Arbeitsverzeichnis
WORKDIR /app

# 4. Dependencies
COPY package*.json ./
RUN npm install --production

# 5. Code & ASSETS kopieren (WICHTIG!)
COPY . .

# 6. Environment
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# 7. Start
CMD [ "node", "server.js" ]