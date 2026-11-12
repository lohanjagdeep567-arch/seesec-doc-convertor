const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');

const { parseRawDocument } = require('./services/parser');
const { generateSeesecDocx } = require('./services/docxFormatter');
const { generateSeesecExcel } = require('./services/excelFormatter');

const app = express();
const PORT = process.env.PORT || 3000;

// Prevent browser caching on localhost so updates are immediate
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Periodic cleanup of temporary conversion files older than 2 hours
function cleanOldUploads() {
  try {
    const files = fs.readdirSync(uploadDir);
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    files.forEach(file => {
      const filePath = path.join(uploadDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && (now - stat.mtimeMs > TWO_HOURS)) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (e) {
    // Ignore locked files
  }
}
setInterval(cleanOldUploads, 30 * 60 * 1000);
cleanOldUploads();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// API: Document Convert (Handles PDF, DOCX, TXT, MD cleanly)
app.post('/api/convert', upload.single('documentFile'), async (req, res) => {
  try {
    let rawContent = req.body.rawContent || '';
    let extractedImages = [];

    // If a file was uploaded
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filePath = req.file.path;

      if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        rawContent = result.value || '';
      } else if (ext === '.pdf') {
        // Cleanly extract text and diagrams from real PDF
        const dataBuffer = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: dataBuffer });
        const result = await parser.getText();
        if (result && Array.isArray(result.pages)) {
          rawContent = result.pages.map(p => p.text).join('\n\n');
        } else {
          rawContent = '';
        }

        // Extract embedded architecture diagrams and charts
        try {
          const imgResult = await parser.getImage({ imageBuffer: true });
          if (imgResult && Array.isArray(imgResult.pages)) {
            imgResult.pages.forEach(p => {
              if (p.images && p.images.length > 0) {
                p.images.forEach((img, idx) => {
                  if (img.width > 200 && img.height > 80 && img.data && img.data.length > 5000) {
                    const imgFilename = `diagram_${Date.now()}_p${p.pageNumber}_${idx}.png`;
                    const publicPath = path.join(__dirname, 'public', 'assets', imgFilename);
                    fs.writeFileSync(publicPath, Buffer.from(img.data));
                    extractedImages.push({
                      pageNumber: p.pageNumber,
                      filename: imgFilename,
                      src: `assets/${imgFilename}`,
                      filePath: publicPath,
                      width: img.width,
                      height: img.height
                    });
                  }
                });
              }
            });
          }
        } catch (imgErr) {
          console.error('Error extracting images from PDF:', imgErr);
        }
      } else {
        rawContent = fs.readFileSync(filePath, 'utf8');
      }
    }

    // Clean up any stray non-printable binary characters to prevent OpenXML corruption
    rawContent = rawContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/g, '');

    if (!rawContent || !rawContent.trim()) {
      return res.status(400).json({ error: 'File khali hai ya text extract nahi ho saka. Kripya check kijiye.' });
    }

    const options = {
      title: req.body.title || '',
      subtitle: req.body.subtitle || '',
      preparedBy: req.body.preparedBy || 'SEESEC Infotech Private Limited',
      preparedFor: req.body.preparedFor || req.body.clientName || '',
      docVersion: (req.body.docVersion && req.body.docVersion.trim()) ? req.body.docVersion.trim() : '',
      date: (req.body.date && req.body.date.trim()) 
        ? req.body.date.trim() 
        : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
      images: extractedImages
    };

    // 1. Parse into structured AST
    const docData = parseRawDocument(rawContent, options);

    // 2. Generate DOCX & Excel with unique timestamped filenames
    const id = Date.now();
    const docxName = `Seesec_${id}.docx`;
    const excelName = `Seesec_${id}.xlsx`;

    await generateSeesecDocx(docData, path.join(uploadDir, docxName));
    await generateSeesecExcel(docData, path.join(uploadDir, excelName));

    res.json({
      success: true,
      docData,
      downloadDocx: `/download/${docxName}`,
      downloadExcel: `/download/${excelName}`
    });
  } catch (err) {
    console.error('Conversion Error:', err);
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
  }
});

// API: Preloaded Sample for 1-Click Senior Demo
app.get('/api/sample-text', (req, res) => {
  const localSample = path.resolve(__dirname, 'samples_motor_insurance.md');
  const externalSample = 'C:/Users/user/.gemini/antigravity/scratch/seesec-document-convertor/samples/motor_insurance_raw.md';
  if (fs.existsSync(localSample)) {
    res.send(fs.readFileSync(localSample, 'utf8'));
  } else if (fs.existsSync(externalSample)) {
    res.send(fs.readFileSync(externalSample, 'utf8'));
  } else {
    res.send('Sample text not found');
  }
});

// API: Official RxLogix Benchmark Sample for Senior Presentations
app.get('/api/sample-rxlogix', (req, res) => {
  const samplePath = path.resolve(__dirname, 'samples_rxlogix.txt');
  if (fs.existsSync(samplePath)) {
    res.json({
      title: 'RxLogix Automation Hub',
      subtitle: 'Licensing Request and Installer Overview',
      preparedBy: 'SEESEC (development team)',
      preparedFor: 'RxLogix (Legal, IT/Security and Delivery)',
      docVersion: '2.0',
      date: 'November 2026',
      content: fs.readFileSync(samplePath, 'utf8')
    });
  } else {
    res.status(404).json({ error: 'Sample not found' });
  }
});

// API: Converted File Download
app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.resolve(uploadDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found: ' + filename });
  }

  const fileBuffer = fs.readFileSync(filePath);

  if (filename.endsWith('.docx')) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } else if (filename.endsWith('.xlsx')) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(fileBuffer);
});

// Start Server
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`Seesec Document Convertor live on: http://localhost:${PORT}`);
  console.log('====================================================');
});
