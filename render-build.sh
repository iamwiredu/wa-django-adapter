#!/bin/bash
set -ex

echo "🚀 Starting Render build process..."

# Install system dependencies
apt-get update
apt-get install -y \
  wget \
  gnupg \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgcc1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  lsb-release \
  xdg-utils

# Download and install Chrome
echo "📥 Installing Google Chrome..."
wget -q -O chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
apt-get install -y ./chrome.deb
rm chrome.deb

# Verify installation
echo "✅ Chrome version:"
google-chrome --version

# Install puppeteer Chrome
echo "📦 Installing Node dependencies..."
npm install

# Install Chrome via puppeteer
echo "🔧 Installing Chrome via puppeteer..."
npx puppeteer browsers install chrome

echo "✅ Build completed successfully!"