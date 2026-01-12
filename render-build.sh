#!/bin/bash
set -ex

# Install dependencies including Chromium
apt-get update
apt-get install -y wget gnupg ca-certificates

# Install Chrome/Chromium for Render
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'
apt-get update
apt-get install -y google-chrome-stable

# Verify installation
which google-chrome
google-chrome --version

# Install Node dependencies
npm install