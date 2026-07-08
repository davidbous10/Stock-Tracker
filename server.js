// ============================================================
// STOCK TRACKER — server.js
// This file is the "brain". Railway runs it 24/7.
// Right now it does exactly two jobs:
//   1. Serve the web page (the public folder)
//   2. Answer one API route: /api/health
// Everything we build later gets added to this file.
// ============================================================

const express = require('express');   // load the Express library
const path = require('path');          // helper for building file paths

const app = express();                 // create the web application

// Middleware: automatically parse JSON in incoming requests.
// We'll need this later when the browser SENDS us data
// (like "add NVDA to my watchlist").
app.use(express.json());

// Serve everything in /public as the website itself.
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// API ROUTE #1: the health check.
// When anything requests GET /api/health, run this function.
//   req = the incoming request (who's asking, what they sent)
//   res = the response we send back
// ------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'alive',
    time: new Date().toISOString(),
    message: 'Stock tracker server is running'
  });
});

// Start listening. Railway supplies the port; 3000 is the local fallback.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stock tracker running on port ${PORT}`);
});
