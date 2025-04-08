require('dotenv').config();
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cors = require('cors');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const rateLimit = require('express-rate-limit');

// Initialize Express app
const app = express();
const upload = multer({
  limits: {
    fileSize: 800 * 1024 * 1024, // 10MB limit
    files: 5 // Maximum 5 files
  }
});

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(limiter);
app.disable('x-powered-by');

// Email transporter configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false // For development only (remove in production)
  }
});

// Verify email configuration
transporter.verify((error) => {
  if (error) {
    logger.error('Email server connection failed:', error);
  } else {
    logger.info('Email server is ready to send messages');
  }
});

// Helper functions
function sanitizeInput(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, value.trim()];
      }
      return [key, value];
    })
  );
}

function formatFieldName(field) {
  const result = field.replace(/([A-Z])/g, ' $1');
  return result.charAt(0).toUpperCase() + result.slice(1);
}

// Main endpoint for case submission
app.post('/SubmitCase', upload.any(), async (req, res) => {
  try {
    const formData = sanitizeInput(req.body);
    console.log('Form Data:', formData);
    const files = req.files || [];

    logger.info('New case submission received', {
      patient: formData.patientName,
      doctor: formData.doctorName
    });

    // Validate required fields
    const requiredFields = [
      'patientName','birthDate','surgeryDate',
      'expeditedRequest','surgicalGuideType','numberOfImplants',
      'implantSystem','implantPositions','implantDimensions','tissueFlapType',
      'doctorName','doctorLicense','doctorPhone','doctorAddress','doctorCity','doctorState','doctorZip',
      'submitterName'
    ];

    const missingFields = requiredFields.filter(field => !formData[field]);
    if (missingFields.length > 0) {
      logger.warn('Missing required fields', { missingFields });
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        missingFields: missingFields.map(formatFieldName)
      });
    }

    // Validate dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (formData.birthDate) {
      const birthDate = new Date(formData.birthDate);
      if (birthDate >= today) {
        return res.status(400).json({
          success: false,
          error: 'Date of Birth must be in the past',
          field: 'birthDate'
        });
      }
    }

    if (formData.surgeryDate) {
      const surgeryDate = new Date(formData.surgeryDate);
      if (surgeryDate <= today) {
        return res.status(400).json({
          success: false,
          error: 'Surgery Date must be in the future',
          field: 'surgeryDate'
        });
      }
    }

    // Validate files
    if (files.length === 0 && !formData.fileLink) {
      return res.status(400).json({
        success: false,
        error: 'Either an uploaded file or a file link is required',
        field: 'fileLink'
      });
    }

    const allowedTypes = [
      'application/octet-stream',
      'application/dicom',
      'application/pdf',
      'image/jpeg',
      'image/png'
    ];

    const invalidFiles = files.filter(file => !allowedTypes.includes(file.mimetype));
    if (invalidFiles.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file type(s) uploaded',
        invalidFiles: invalidFiles.map(f => f.originalname)
      });
    }

    // Generate PDF
    const pdfBytes = await generatePdf(formData);

    // Prepare email attachments
    const attachments = [
      {
        filename: 'Case_Details.pdf',
        content: pdfBytes
      },
      ...files.map((file) => ({
        filename: file.originalname,
        content: file.buffer,
      }))
    ];

    // Send email
    const mailOptions = {
      from: `"Case Submission" <${process.env.EMAIL_USER}>`,
      to: process.env.RECIPIENT_EMAIL || 'guideme@guided4excellence.com',
      subject: 'New Case Submission',
      html: generateEmailHtml(formData),
      attachments: attachments,
    };

    await transporter.sendMail(mailOptions);
    logger.info('Case submitted successfully', { patient: formData.patientName });

    res.status(200).json({
      success: true,
      message: 'Case submitted successfully',
      pdfGenerated: true,
      filesAttached: files.length
    });

  } catch (error) {
    logger.error('Error submitting case:', error);
    
    let statusCode = 500;
    let errorMessage = 'Error submitting case';
    
    if (error.code === 'EAUTH') {
      statusCode = 503;
      errorMessage = 'Email service configuration error';
    } else if (error instanceof multer.MulterError) {
      statusCode = 400;
      errorMessage = 'File upload error: ' + error.message;
    } else if (error.message.includes('PDF generation')) {
      statusCode = 422;
      errorMessage = error.message;
    }
    
    res.status(statusCode).json({ 
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// PDF Generation
async function generatePdf(formData) {
  try {
    if (!formData || Object.keys(formData).length === 0) {
      throw new Error('PDF generation failed: No form data provided');
    }

    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    
    let font;
    try {
      const fontPath = path.join(__dirname, 'fonts', 'Roboto-Regular.ttf');
      if (fs.existsSync(fontPath)) {
        const fontBytes = fs.readFileSync(fontPath);
        font = await pdfDoc.embedFont(fontBytes);
      } else {
        font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      }
    } catch (fontError) {
      logger.warn('Using standard Helvetica font');
      font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }

    const page = pdfDoc.addPage([595, 842]); // A4 size

    // Header
    page.drawText('Guided Excellence - Case Submission', {
      x: 50,
      y: 780,
      size: 20,
      font,
      color: rgb(0.05, 0.07, 0.32),
    });
    
    page.drawText('Case Details', {
      x: 50,
      y: 750,
      size: 16,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
    
    page.drawLine({
      start: { x: 50, y: 740 },
      end: { x: 545, y: 740 },
      thickness: 1,
      color: rgb(0.8, 0.8, 0.8),
    });
    
    // Content sections
    const sections = [
      {
        title: 'Patient Information',
        fields: ['patientName', 'birthDate', 'surgeryDate']
      },
      {
        title: 'Planning Information',
        fields: ['surgicalGuideType', 'numberOfImplants', 'expeditedRequest']
      },
      {
        title: 'Implant System',
        fields: ['implantSystem', 'implantPositions', 'implantDimensions', 'tissueFlapType']
      },
      {
        title: 'Doctor Information',
        fields: ['doctorName', 'doctorLicense', 'doctorPhone', 'doctorAddress', 'doctorCity', 'doctorState', 'doctorZip']
      }
    ];

    let yPosition = 710;
    const sectionGap = 20;
    const fieldGap = 15;

    sections.forEach(section => {
      page.drawText(`${section.title}:`, {
        x: 50,
        y: yPosition,
        size: 14,
        font,
        color: rgb(0.05, 0.07, 0.32),
      });
      yPosition -= sectionGap;

      section.fields.forEach(field => {
        if (formData[field]) {
          page.drawText(`${formatFieldName(field)}: ${formData[field]}`, {
            x: 60,
            y: yPosition,
            size: 12,
            font,
            color: rgb(0.2, 0.2, 0.2),
          });
          yPosition -= fieldGap;
        }
      });

      yPosition -= sectionGap;
    });

    // Footer
    page.drawText(`Submitted on: ${new Date().toLocaleString()}`, {
      x: 50,
      y: 50,
      size: 10,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });

    return await pdfDoc.save();
  } catch (error) {
    logger.error('PDF generation failed:', error);
    throw new Error(`PDF generation failed: ${error.message}`);
  }
}

// Email HTML Generation
function generateEmailHtml(formData) {
  const sections = [
    {
      title: 'Patient Information',
      fields: ['patientName', 'birthDate', 'surgeryDate']
    },
    {
      title: 'Planning Information',
      fields: ['surgicalGuideType', 'numberOfImplants', 'expeditedRequest']
    },
    {
      title: 'Implant System',
      fields: ['implantSystem', 'implantPositions', 'implantDimensions', 'tissueFlapType']
    },
    {
      title: 'Doctor Information',
      fields: ['doctorName', 'doctorLicense', 'doctorPhone', 'doctorAddress', 'doctorCity', 'doctorState', 'doctorZip']
    }
  ];

  const renderSection = (section) => `
    <div style="margin-bottom: 30px;">
      <h2 style="color: #0c1152;">${section.title}</h2>
      ${section.fields.map(field => {
        if (formData[field]) {
          return `
            <p style="margin: 5px 0;">
              <strong style="color: #333;">${formatFieldName(field)}:</strong> 
              <span style="color: #555;">${formData[field]}</span>
            </p>
          `;
        }
        return '';
      }).join('')}
    </div>
  `;

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #0c1152; border-bottom: 2px solid #0c1152; padding-bottom: 10px;">
        New Case Submission
      </h1>
      ${sections.map(renderSection).join('')}
      <p style="font-size: 12px; color: #666; margin-top: 30px;">
        This case submission includes a PDF with all details attached.
      </p>
    </div>
  `;
}

// Health check endpoint
app.get('/SubmitCase', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version
  });
});

// Basic endpoint
app.get('/', (req, res) => {
  res.send('Guided Excellence Case Submission API');
});

// Error handling for undefined routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
  console.log(`Server running on port ${port}`);
});
