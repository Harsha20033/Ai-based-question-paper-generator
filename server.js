const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const socketIo = require('socket.io');
const pdfParse = require('pdf-parse');
const { fromPath } = require('pdf2pic');
const { createWorker } = require('tesseract.js');
const puppeteer = require('puppeteer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Force IPv4 for outbound requests to avoid IPv6 connectivity issues on some networks
try {
  if (!process.env.NODE_OPTIONS || !process.env.NODE_OPTIONS.includes('--dns-result-order')) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --dns-result-order=ipv4first`.trim();
    console.log('Networking: Set NODE_OPTIONS --dns-result-order=ipv4first');
  }
} catch (e) {
  console.log('Networking: Unable to set IPv4 preference via NODE_OPTIONS');
}

// Load environment variables manually (bypassing dotenv issues)
try {
  const envContent = require('fs').readFileSync('.env', 'utf8');
  const lines = envContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  
  lines.forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      process.env[key.trim()] = value.trim();
      console.log(`Loaded env var: ${key.trim()} = ${value.trim().substring(0, 10)}...`);
    }
  });
  
  console.log('Environment variables loaded manually from .env file');
  console.log('- GEMINI_API_KEY loaded:', process.env.GEMINI_API_KEY ? 'YES' : 'NO');
  if (process.env.GEMINI_API_KEY) {
    console.log('- API Key preview:', process.env.GEMINI_API_KEY.substring(0, 10) + '...');
    console.log('- Full API Key length:', process.env.GEMINI_API_KEY.length);
  }
  
  // Double-check the environment variable
  console.log('Final check - process.env.GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET');
} catch (error) {
  console.error('Error loading .env file manually:', error);
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    fs.ensureDirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  }
});

// Multiple file upload configuration
const multiUpload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit per file
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  }
});

// Initialize Gemini AI
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY not set. AI features will be disabled.');
} else {
  console.log('SUCCESS: GEMINI_API_KEY is set and ready for AI features');
  console.log('- API Key preview:', GEMINI_API_KEY.substring(0, 10) + '...');
}
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// Bloom's Taxonomy levels
const BLOOM_LEVELS = {
  REMEMBER: { name: 'Remember', code: 'CO1', description: 'Recall facts and basic concepts' },
  UNDERSTAND: { name: 'Understand', code: 'CO2', description: 'Explain ideas and concepts' },
  APPLY: { name: 'Apply', code: 'CO3', description: 'Use information in new situations' },
  ANALYZE: { name: 'Analyze', code: 'CO4', description: 'Draw connections among ideas' },
  EVALUATE: { name: 'Evaluate', code: 'CO5', description: 'Justify a stand or decision' },
  CREATE: { name: 'Create', code: 'CO6', description: 'Produce new or original work' }
};

// Question types
const QUESTION_TYPES = {
  MULTIPLE_CHOICE: 'multiple-choice',
  TRUE_FALSE: 'true-false',
  SHORT_ANSWER: 'short-answer',
  ESSAY: 'essay',
  FILL_BLANK: 'fill-blank'
};

// Global session storage (in production, use Redis or database)
const sessionStorage = new Map();

// Multi-document session storage
const multiDocSessions = new Map();

// AI Question Generator Class
class AIQuestionGenerator {
  constructor() {
    this.content = '';
    this.visualElements = [];
    this.documents = []; // Array to store multiple documents
  }

  async extractContent(filePath, fileType) {
    try {
      if (fileType === 'application/pdf') {
        const dataBuffer = await fs.readFile(filePath);
        const data = await pdfParse(dataBuffer);
        this.content = data.text;
        
        // Extract images from PDF
        await this.extractImagesFromPDF(filePath);
      } else if (fileType.startsWith('image/')) {
        // OCR for images
        await this.extractTextFromImage(filePath);
      }
      
      return this.content;
    } catch (error) {
      console.error('Error extracting content:', error);
      throw error;
    }
  }

  async addDocument(filePath, fileType, fileName) {
    try {
      const documentData = {
        id: uuidv4(),
        fileName: fileName,
        content: '',
        visualElements: [],
        filePath: filePath,
        fileType: fileType
      };

      if (fileType === 'application/pdf') {
        const dataBuffer = await fs.readFile(filePath);
        const data = await pdfParse(dataBuffer);
        documentData.content = data.text;
        
        // Extract images from PDF
        await this.extractImagesFromPDF(filePath);
        documentData.visualElements = [...this.visualElements];
      } else if (fileType.startsWith('image/')) {
        // OCR for images
        await this.extractTextFromImage(filePath);
        documentData.content = this.content;
      }

      this.documents.push(documentData);
      
      // Update combined content
      this.content = this.documents.map(doc => `${doc.content}\n\n--- Document: ${doc.fileName} ---\n\n`).join('');
      
      return documentData;
    } catch (error) {
      console.error('Error adding document:', error);
      throw error;
    }
  }

  getDocumentById(documentId) {
    return this.documents.find(doc => doc.id === documentId);
  }

  getAllDocuments() {
    return this.documents.map(doc => ({
      id: doc.id,
      fileName: doc.fileName,
      contentLength: doc.content.length,
      fileType: doc.fileType
    }));
  }

  async extractImagesFromPDF(filePath) {
    try {
      const options = {
        density: 100,
        saveFilename: "page",
        savePath: path.dirname(filePath),
        format: "png",
        width: 600,
        height: 600
      };
      
      const convert = fromPath(filePath, options);
      const pageData = await convert(1); // Convert first page
      
      if (pageData) {
        this.visualElements.push({
          type: 'image',
          path: pageData.path,
          description: 'Extracted from PDF'
        });
      }
    } catch (error) {
      // Handle EPIPE and other stream errors gracefully
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
        console.log('Image extraction skipped due to stream error (this is normal for some PDFs)');
      } else {
        console.error('Error extracting images:', error);
      }
      // Continue without images - this is not critical for question generation
    }
  }

  async extractTextFromImage(filePath) {
    try {
      const worker = await createWorker();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      
      const { data: { text } } = await worker.recognize(filePath);
      this.content = text;
      
      await worker.terminate();
    } catch (error) {
      console.error('Error extracting text from image:', error);
      throw error;
    }
  }

  async generateQuestions(requirements) {
    const {
      totalMarks = 50,
      questionCount = 10,
      bloomDistribution = 'balanced',
      questionTypes = [QUESTION_TYPES.MULTIPLE_CHOICE],
      difficulty = 'medium',
      useAI = true
    } = requirements;

    // Try AI generation first if enabled and API key is available
    if (useAI && GEMINI_API_KEY && genAI) {
      try {
        console.log('Using AI for question generation...');
        console.log('Content length:', this.content ? this.content.length : 'NO CONTENT');
        console.log('Content preview:', this.content ? this.content.substring(0, 200) + '...' : 'NO CONTENT');
        const aiResult = await this.generateAIQuestions(this.content, {
          totalQuestions: questionCount,
          questionTypes,
          bloomDistribution,
          difficulty,
          courseOutcomes: requirements.courseOutcomes
        });
        const withAnswers = this.ensureAnswers(aiResult.questions);
        return withAnswers;
      } catch (error) {
        console.log('AI generation failed, falling back to rule-based generation:', error.message);
      }
    }

    // Fallback to rule-based generation
    const questions = [];
    const contentSections = this.splitContentIntoSections();
    
    // Generate questions based on Bloom's Taxonomy distribution
    const distribution = this.calculateBloomDistribution(bloomDistribution, questionCount);
    
    Object.entries(distribution).forEach(([level, count]) => {
      for (let i = 0; i < count; i++) {
        const question = this.generateQuestionByLevel(level, contentSections, questionTypes, difficulty);
        if (question) {
          questions.push(question);
        }
      }
    });

    return this.ensureAnswers(questions);
  }

  splitContentIntoSections() {
    // Handle undefined content
    if (!this.content || typeof this.content !== 'string') {
      return ['Sample content section for question generation'];
    }
    
    // Split content into logical sections for question generation
    const paragraphs = this.content.split('\n\n').filter(p => p.trim().length > 50);
    return paragraphs.length > 0 ? paragraphs : ['Sample content section for question generation'];
  }

  calculateBloomDistribution(type, totalQuestions) {
    const distributions = {
      balanced: {
        REMEMBER: Math.ceil(totalQuestions * 0.2),
        UNDERSTAND: Math.ceil(totalQuestions * 0.2),
        APPLY: Math.ceil(totalQuestions * 0.2),
        ANALYZE: Math.ceil(totalQuestions * 0.15),
        EVALUATE: Math.ceil(totalQuestions * 0.15),
        CREATE: Math.ceil(totalQuestions * 0.1)
      },
      foundational: {
        REMEMBER: Math.ceil(totalQuestions * 0.4),
        UNDERSTAND: Math.ceil(totalQuestions * 0.3),
        APPLY: Math.ceil(totalQuestions * 0.2),
        ANALYZE: Math.ceil(totalQuestions * 0.1),
        EVALUATE: 0,
        CREATE: 0
      },
      advanced: {
        REMEMBER: Math.ceil(totalQuestions * 0.1),
        UNDERSTAND: Math.ceil(totalQuestions * 0.15),
        APPLY: Math.ceil(totalQuestions * 0.2),
        ANALYZE: Math.ceil(totalQuestions * 0.25),
        EVALUATE: Math.ceil(totalQuestions * 0.2),
        CREATE: Math.ceil(totalQuestions * 0.1)
      }
    };

    return distributions[type] || distributions.balanced;
  }

  generateQuestionByLevel(bloomLevel, contentSections, questionTypes, difficulty) {
    const level = BLOOM_LEVELS[bloomLevel];
    const questionType = questionTypes[Math.floor(Math.random() * questionTypes.length)];
    
    // Handle empty content sections
    let content = 'Sample content for question generation';
    if (contentSections && contentSections.length > 0) {
      content = contentSections[Math.floor(Math.random() * contentSections.length)];
    }

    const question = {
      id: uuidv4(),
      type: questionType,
      bloomLevel: bloomLevel,
      bloomCode: level.code,
      difficulty: difficulty,
      content: this.generateQuestionContent(bloomLevel, content, questionType),
      options: this.generateOptions(questionType, content),
      correctAnswer: '',
      explanation: '',
      answer: '',
      marks: this.calculateMarks(bloomLevel, questionType, difficulty)
    };

    // Auto-generate answer/correctAnswer/explanation for rule-based questions
    const auto = this.generateAnswer(question, content);
    if (!question.correctAnswer && auto.correctAnswer) question.correctAnswer = auto.correctAnswer;
    if (!question.explanation && auto.explanation) question.explanation = auto.explanation;
    if (!question.answer && auto.answer) question.answer = auto.answer;

    return question;
  }

  generateQuestionContent(bloomLevel, content, questionType) {
    // Handle undefined or null content
    if (!content || typeof content !== 'string') {
      content = this.content || 'Sample content for question generation';
    }
    
    // Analyze the actual content to extract meaningful information
    const analysis = this.analyzeContent(content);
    
    // Check if this is a multi-document scenario
    const isMultiDoc = this.documents.length > 1;
    const docNames = this.documents.map(doc => doc.fileName);

    // Generate questions based on actual content analysis
    const questions = {
      REMEMBER: {
        'multiple-choice': this.generateRememberMCQ(analysis, isMultiDoc),
        'true-false': this.generateRememberTF(analysis, isMultiDoc),
        'short-answer': this.generateRememberSA(analysis, isMultiDoc),
        'fill-blank': this.generateRememberFillBlank(analysis, isMultiDoc)
      },
      UNDERSTAND: {
        'multiple-choice': this.generateUnderstandMCQ(analysis, isMultiDoc),
        'true-false': this.generateUnderstandTF(analysis, isMultiDoc),
        'short-answer': this.generateUnderstandSA(analysis, isMultiDoc),
        'essay': this.generateUnderstandEssay(analysis, isMultiDoc)
      },
      APPLY: {
        'multiple-choice': this.generateApplyMCQ(analysis, isMultiDoc),
        'short-answer': this.generateApplySA(analysis, isMultiDoc),
        'essay': this.generateApplyEssay(analysis, isMultiDoc)
      },
      ANALYZE: {
        'multiple-choice': this.generateAnalyzeMCQ(analysis, isMultiDoc),
        'short-answer': this.generateAnalyzeSA(analysis, isMultiDoc),
        'essay': this.generateAnalyzeEssay(analysis, isMultiDoc)
      },
      EVALUATE: {
        'multiple-choice': this.generateEvaluateMCQ(analysis, isMultiDoc),
        'short-answer': this.generateEvaluateSA(analysis, isMultiDoc),
        'essay': this.generateEvaluateEssay(analysis, isMultiDoc)
      },
      CREATE: {
        'short-answer': this.generateCreateSA(analysis, isMultiDoc),
        'essay': this.generateCreateEssay(analysis, isMultiDoc)
      }
    };

    return questions[bloomLevel]?.[questionType] || 'Generate a question based on the content.';
  }

  analyzeContent(content) {
    // Extract key concepts, facts, and relationships from the content
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
    const words = content.toLowerCase().match(/\b\w+\b/g) || [];
    
    // Filter out common words and get meaningful terms
    const stopWords = new Set(['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'a', 'an', 'as', 'from', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'among', 'within', 'without', 'against', 'toward', 'towards', 'upon', 'about', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'you', 'your', 'yours', 'yourself', 'yourselves', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'what', 'which', 'who', 'whom', 'whose', 'whichever', 'whoever', 'whomever', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was', 'were', 'being', 'been', 'be', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'shall', 'can']);
    
    const wordFreq = {};
    words.forEach(word => {
      if (word.length > 3 && !stopWords.has(word)) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    });
    
    // Get key terms and concepts
    const keyTerms = Object.entries(wordFreq)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 15)
      .map(([term]) => term);
    
    // Extract important sentences (those containing key terms)
    const importantSentences = sentences.filter(sentence => 
      keyTerms.some(term => sentence.toLowerCase().includes(term))
    );
    
    // Identify main topics
    const mainTopics = keyTerms.slice(0, 5);
    
    // Find definitions and explanations
    const definitions = sentences.filter(sentence => 
      sentence.toLowerCase().includes('is a') || 
      sentence.toLowerCase().includes('refers to') ||
      sentence.toLowerCase().includes('defined as') ||
      sentence.toLowerCase().includes('means')
    );
    
    return {
      keyTerms,
      mainTopics,
      importantSentences,
      definitions,
      totalSentences: sentences.length,
      totalWords: words.length,
      uniqueWords: Object.keys(wordFreq).length
    };
  }

  generateOptions(questionType, content) {
    // Handle undefined or null content
    if (!content || typeof content !== 'string') {
      content = this.content || 'Sample content for question generation';
    }
    
    if (questionType === QUESTION_TYPES.MULTIPLE_CHOICE) {
      // Use the same analysis as question generation
      const analysis = this.analyzeContent(content);
      const keyTerms = analysis.keyTerms;
      
      // Generate more meaningful options based on content
      const options = [];
      
      if (keyTerms.length >= 4) {
        options.push(
          `${keyTerms[0]} (primary concept)`,
          `${keyTerms[1]} (related concept)`,
          `${keyTerms[2]} (alternative approach)`,
          `${keyTerms[3]} (supporting element)`
        );
      } else {
        // Fallback options
        options.push(
          'Primary concept (most relevant)',
          'Secondary concept (related)',
          'Alternative approach (different perspective)',
          'Supporting element (complementary)'
        );
      }
      
      return options;
    } else if (questionType === QUESTION_TYPES.TRUE_FALSE) {
      return ['True', 'False'];
    }
    return [];
  }

  // Remember Level Question Generators
  generateRememberMCQ(analysis, isMultiDoc) {
    const { keyTerms, mainTopics } = analysis;
    if (keyTerms.length < 2) return 'What is the main topic discussed in this content?';
    
    const topic1 = keyTerms[0];
    const topic2 = keyTerms[1];
    const topic3 = keyTerms[2] || 'concept';
    const topic4 = keyTerms[3] || 'element';
    
    return isMultiDoc 
      ? `Which of the following terms appears most frequently across all documents: ${topic1}, ${topic2}, ${topic3}, or ${topic4}?`
      : `Which of the following terms is most frequently mentioned in the document: ${topic1}, ${topic2}, ${topic3}, or ${topic4}?`;
  }

  generateRememberTF(analysis, isMultiDoc) {
    const { mainTopics } = analysis;
    if (mainTopics.length < 2) return 'The document discusses important concepts related to the main topic.';
    
    return isMultiDoc
      ? `The documents primarily discuss ${mainTopics[0]} and ${mainTopics[1]} across multiple sources.`
      : `The document primarily discusses ${mainTopics[0]} and ${mainTopics[1]}.`;
  }

  generateRememberSA(analysis, isMultiDoc) {
    return isMultiDoc
      ? `List the main topics and key concepts discussed across all the uploaded documents.`
      : `List the main topics and key concepts discussed in this document.`;
  }

  generateRememberFillBlank(analysis, isMultiDoc) {
    const { mainTopics } = analysis;
    const topic = mainTopics[0] || 'the main concept';
    
    return isMultiDoc
      ? `The documents collectively focus on _____ and its applications.`
      : `The document focuses on _____ and its applications.`;
  }

  // Understand Level Question Generators
  generateUnderstandMCQ(analysis, isMultiDoc) {
    const { keyTerms, definitions } = analysis;
    if (keyTerms.length < 2) return 'Which statement best explains the main concept discussed in this content?';
    
    return isMultiDoc
      ? `Based on the documents, which statement best explains the relationship between ${keyTerms[0]} and ${keyTerms[1]}?`
      : `Based on the document, which statement best explains the relationship between ${keyTerms[0]} and ${keyTerms[1]}?`;
  }

  generateUnderstandTF(analysis, isMultiDoc) {
    const { keyTerms } = analysis;
    if (keyTerms.length < 2) return 'The document explains important concepts clearly.';
    
    return isMultiDoc
      ? `The documents explain that ${keyTerms[0]} is essential for understanding ${keyTerms[1]}.`
      : `The document explains that ${keyTerms[0]} is essential for understanding ${keyTerms[1]}.`;
  }

  generateUnderstandSA(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Explain the main concepts and their relationships as discussed across all documents in your own words.`
      : `Explain the main concepts and their relationships as discussed in this document in your own words.`;
  }

  generateUnderstandEssay(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Describe and explain the key concepts and their relationships as presented across all documents.`
      : `Describe and explain the key concepts and their relationships as presented in the document.`;
  }

  // Apply Level Question Generators
  generateApplyMCQ(analysis, isMultiDoc) {
    const { mainTopics } = analysis;
    const topic = mainTopics[0] || 'the concepts';
    
    return isMultiDoc
      ? `How would you apply the principles discussed across all documents to solve a real-world problem?`
      : `How would you apply the principles discussed in this document to solve a real-world problem?`;
  }

  generateApplySA(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Apply the concepts from all documents to create a practical solution for a given scenario.`
      : `Apply the concepts from this document to create a practical solution for a given scenario.`;
  }

  generateApplyEssay(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Demonstrate how the concepts discussed across all documents can be applied in a real-world situation.`
      : `Demonstrate how the concepts discussed in this document can be applied in a real-world situation.`;
  }

  // Analyze Level Question Generators
  generateAnalyzeMCQ(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Which of the following best analyzes the relationships between concepts across all documents?`
      : `Which of the following best analyzes the structure and organization of ideas in this document?`;
  }

  generateAnalyzeSA(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Analyze the differences and similarities between the main concepts discussed across all documents.`
      : `Analyze the differences and similarities between the main concepts discussed in this document.`;
  }

  generateAnalyzeEssay(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Analyze the structure, organization, and relationships between the ideas presented across all documents.`
      : `Analyze the structure, organization, and relationships between the ideas presented in this document.`;
  }

  // Evaluate Level Question Generators
  generateEvaluateMCQ(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Which argument presented across all documents is most convincing based on the evidence provided?`
      : `Which argument presented in the document is most convincing based on the evidence provided?`;
  }

  generateEvaluateSA(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Evaluate the effectiveness of the approaches and methods described across all documents.`
      : `Evaluate the effectiveness of the approaches and methods described in this document.`;
  }

  generateEvaluateEssay(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Evaluate the strengths and weaknesses of the arguments and evidence presented across all documents.`
      : `Evaluate the strengths and weaknesses of the arguments and evidence presented in this document.`;
  }

  // Create Level Question Generators
  generateCreateSA(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Design a new solution or approach based on the principles and concepts discussed across all documents.`
      : `Design a new solution or approach based on the principles and concepts discussed in this document.`;
  }

  generateCreateEssay(analysis, isMultiDoc) {
    return isMultiDoc
      ? `Create a comprehensive plan or proposal that builds upon the concepts and ideas presented across all documents.`
      : `Create a comprehensive plan or proposal that builds upon the concepts and ideas presented in this document.`;
  }

  calculateMarks(bloomLevel, questionType, difficulty) {
    const baseMarks = {
      REMEMBER: 2,
      UNDERSTAND: 3,
      APPLY: 4,
      ANALYZE: 5,
      EVALUATE: 6,
      CREATE: 8
    };

    const difficultyMultiplier = {
      easy: 0.8,
      medium: 1.0,
      hard: 1.2
    };

    const typeMultiplier = {
      'multiple-choice': 1.0,
      'true-false': 0.5,
      'short-answer': 1.5,
      'essay': 2.0,
      'fill-blank': 0.8
    };

    return Math.round(baseMarks[bloomLevel] * difficultyMultiplier[difficulty] * typeMultiplier[questionType]);
  }

  generateExamPaper(questions, examConfig) {
    const {
      institutionName = 'Kalasalingam Academy of Research and Education',
      courseCode = 'CS101',
      courseName = 'Computer Science Fundamentals',
      degree = 'B.Tech',
      semester = 'I',
      examSession = 'Seasonal Examination – December 2024',
      duration = '90 Minutes',
      date = new Date().toLocaleDateString(),
      maxMarks = 50
    } = examConfig;

    // Group questions by parts
    const partA = questions.slice(0, Math.ceil(questions.length * 0.6));
    const partB = questions.slice(Math.ceil(questions.length * 0.6));

    const examPaper = {
      header: {
        institutionName,
        courseCode,
        courseName,
        degree,
        semester,
        examSession,
        duration,
        date,
        maxMarks
      },
      parts: [
        {
          name: 'Part A',
          description: `(${partA.length} x 2 = ${partA.reduce((sum, q) => sum + q.marks, 0)} Marks)`,
          questions: partA
        },
        {
          name: 'Part B',
          description: `(${partB.length} x 3 = ${partB.reduce((sum, q) => sum + q.marks, 0)} Marks)`,
          questions: partB
        }
      ],
      summary: this.generateSummaryTable(questions)
    };

    return examPaper;
  }

  async generateAIQuestions(content, requirements) {
    try {
          if (!GEMINI_API_KEY || !genAI) {
        throw new Error('Gemini API key not configured. Please set GEMINI_API_KEY in your .env file.');
      }

      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      
      const prompt = this.createAIPrompt(content, requirements);
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      console.log('AI Response received, length:', text.length);
      console.log('AI Response preview:', text.substring(0, 500) + '...');
      
      const parsedResult = this.parseAIResponse(text, requirements);
      console.log('Parsed result questions count:', parsedResult.questions ? parsedResult.questions.length : 'NO QUESTIONS');
      
      return parsedResult;
    } catch (error) {
      console.error('AI Question Generation Error:', error);
      throw new Error(`AI question generation failed: ${error.message}`);
    }
  }

  createAIPrompt(content, requirements) {
    const { totalQuestions, questionTypes, bloomDistribution, difficulty, courseOutcomes } = requirements;
    
    console.log('Creating AI prompt with content length:', content ? content.length : 'NO CONTENT');
    console.log('Content preview for AI:', content ? content.substring(0, 300) + '...' : 'NO CONTENT');
    
    const prompt = `You are an expert educational content creator specializing in creating questions based on Bloom's Taxonomy. 

CONTENT TO ANALYZE:
${content ? content.substring(0, 8000) : 'No content provided'} // Limiting content to avoid token limits

REQUIREMENTS:
- Total Questions: ${totalQuestions}
- Question Types: ${questionTypes.join(', ')}
- Bloom's Taxonomy Distribution: ${JSON.stringify(bloomDistribution)}
- Difficulty Level: ${difficulty}
- Course Outcomes: ${courseOutcomes ? courseOutcomes.join(', ') : 'Not specified'}

INSTRUCTIONS:
1. Analyze the provided content thoroughly
2. Generate questions that are directly based on the content
3. Ensure questions are relevant and accurate to the source material
4. Create questions for each Bloom's Taxonomy level as specified in the distribution
5. Include 4 options for multiple choice questions with only one correct answer
6. Provide detailed explanations for correct answers
7. For each question, provide a comprehensive answer that explains the reasoning
8. IMPORTANT: You must respond with ONLY a valid JSON object, no additional text

RESPONSE FORMAT (JSON ONLY):
{
  "questions": [
    {
      "id": "Q1",
      "question": "Question text here",
      "type": "multiple-choice",
      "bloomLevel": "REMEMBER",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Correct answer text",
      "explanation": "Detailed explanation of why this is correct",
      "answer": "Comprehensive answer with step-by-step reasoning and key concepts",
      "marks": 2,
      "difficulty": "medium"
    }
  ],
  "summary": {
    "totalQuestions": ${totalQuestions},
    "bloomDistribution": ${JSON.stringify(bloomDistribution)},
    "totalMarks": ${totalQuestions * 2}
  }
}

CRITICAL: Respond with ONLY the JSON object above. No additional text, explanations, or formatting.`;

    return prompt;
  }

  parseAIResponse(aiResponse, requirements) {
    try {
      console.log('Parsing AI response...');
      console.log('Response type:', typeof aiResponse);
      console.log('Response length:', aiResponse.length);
      
      // Extract JSON from the response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log('No JSON found in response, trying to parse as plain text...');
        // If no JSON found, try to create questions from plain text
        return this.createQuestionsFromText(aiResponse, requirements);
      }

      console.log('JSON found, attempting to parse...');
      const parsed = JSON.parse(jsonMatch[0]);
      
      if (!parsed.questions || !Array.isArray(parsed.questions)) {
        throw new Error('Invalid question format in AI response');
      }

      // Transform AI questions to match our format
      let transformedQuestions = parsed.questions.map((q, index) => ({
        id: q.id || `Q${index + 1}`,
        content: q.question, // Frontend expects 'content' not 'question'
        type: q.type,
        bloomLevel: q.bloomLevel,
        bloomCode: BLOOM_LEVELS[q.bloomLevel] ? BLOOM_LEVELS[q.bloomLevel].code : 'CO1', // Add bloomCode
        options: q.options || [],
        correctAnswer: q.correctAnswer,
        explanation: q.explanation,
        answer: q.answer || q.correctAnswer || '',
        marks: q.marks || this.calculateMarks(q.bloomLevel, q.type, requirements.difficulty),
        difficulty: q.difficulty || requirements.difficulty
      }));

      // If AI returned fewer than requested, top up with rule-based questions
      const target = requirements.totalQuestions || requirements.questionCount || transformedQuestions.length;
      if (transformedQuestions.length < target) {
        const needed = target - transformedQuestions.length;
        const contentSections = this.splitContentIntoSections();
        const allTypes = requirements.questionTypes && requirements.questionTypes.length ? requirements.questionTypes : [QUESTION_TYPES.MULTIPLE_CHOICE];
        const levels = Object.keys(BLOOM_LEVELS);
        for (let i = 0; i < needed; i++) {
          const level = levels[i % levels.length];
          const qb = this.generateQuestionByLevel(level, contentSections, allTypes, requirements.difficulty || 'medium');
          if (qb) {
            transformedQuestions.push(qb);
          }
        }
      }

      return {
        questions: transformedQuestions.slice(0, target),
        summary: parsed.summary || {
          totalQuestions: Math.min(transformedQuestions.length, target),
          bloomDistribution: requirements.bloomDistribution,
          totalMarks: transformedQuestions.reduce((sum, q) => sum + q.marks, 0)
        }
      };
    } catch (error) {
      console.error('Error parsing AI response:', error);
      console.log('Falling back to text-based question generation...');
      return this.createQuestionsFromText(aiResponse, requirements);
    }
  }

  createQuestionsFromText(text, requirements) {
    console.log('Creating questions from text response...');
    
    // Split text into lines and look for question patterns
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    const questions = [];
    
    let currentQuestion = null;
    
    for (let i = 0; i < lines.length && questions.length < requirements.totalQuestions; i++) {
      const line = lines[i].trim();
      
      // Look for question patterns
      if (line.match(/^\d+\.\s/) || line.match(/^Q\d+\.\s/) || line.match(/^Question\s\d+:/i)) {
        if (currentQuestion) {
          questions.push(currentQuestion);
        }
        
        currentQuestion = {
          id: `Q${questions.length + 1}`,
          content: line.replace(/^\d+\.\s|^Q\d+\.\s|^Question\s\d+:\s*/i, ''),
          type: 'multiple-choice',
          bloomLevel: 'REMEMBER',
          bloomCode: 'CO1',
          options: [],
          correctAnswer: '',
          explanation: '',
          answer: '',
          marks: 2,
          difficulty: requirements.difficulty
        };
      } else if (currentQuestion && line.match(/^[A-D]\.\s/)) {
        // This is an option
        currentQuestion.options.push(line.replace(/^[A-D]\.\s/, ''));
      } else if (currentQuestion && line.toLowerCase().includes('answer:')) {
        // This is the answer
        const ans = line.replace(/answer:\s*/i, '');
        currentQuestion.correctAnswer = ans;
        currentQuestion.answer = ans;
      }
    }
    
    // Add the last question if exists
    if (currentQuestion) {
      questions.push(currentQuestion);
    }
    
    // If no questions found, create a simple one from the content
    if (questions.length === 0) {
      console.log('No questions found in text, creating fallback question...');
      questions.push({
        id: 'Q1',
        content: 'Based on the provided content, what is the main topic discussed?',
        type: 'multiple-choice',
        bloomLevel: 'REMEMBER',
        bloomCode: 'CO1',
        options: ['Topic A', 'Topic B', 'Topic C', 'Topic D'],
        correctAnswer: 'Topic A',
        explanation: 'This question tests understanding of the main topic from the content.',
        answer: 'Topic A',
        marks: 2,
        difficulty: requirements.difficulty
      });
    }
    
    console.log(`Created ${questions.length} questions from text`);
    
    return {
      questions: this.ensureAnswers(questions),
      summary: {
        totalQuestions: questions.length,
        bloomDistribution: requirements.bloomDistribution,
        totalMarks: questions.reduce((sum, q) => sum + q.marks, 0)
      }
    };
  }

  // Generate default answers/explanations for rule-based questions
  generateAnswer(question, content) {
    try {
      const analysis = this.analyzeContent(content || this.content || '');
      const mainTopic = (analysis.mainTopics && analysis.mainTopics[0]) || 'the main concept';

      if (question.type === QUESTION_TYPES.MULTIPLE_CHOICE) {
        const fallback = question.options && question.options.length > 0 ? question.options[0] : 'Option A';
        return {
          correctAnswer: question.correctAnswer || fallback,
          explanation: `The chosen option aligns best with key terms found in the content, notably ${mainTopic}.`,
          answer: question.correctAnswer || fallback
        };
      }

      if (question.type === QUESTION_TYPES.TRUE_FALSE) {
        return {
          correctAnswer: question.correctAnswer || 'True',
          explanation: `Based on the analyzed content, the statement reflects the discussed concepts about ${mainTopic}.`,
          answer: question.correctAnswer || 'True'
        };
      }

      if (question.type === QUESTION_TYPES.SHORT_ANSWER) {
        const terms = (analysis.keyTerms || []).slice(0, 3).join(', ');
        const ans = `It relates to ${mainTopic}${terms ? `, involving ${terms}` : ''}.`;
        return {
          correctAnswer: question.correctAnswer || '',
          explanation: `Answer synthesized from prominent topics and terms detected in the content.`,
          answer: ans
        };
      }

      if (question.type === QUESTION_TYPES.ESSAY) {
        const points = (analysis.mainTopics || []).slice(0, 4).map((t, i) => `${i + 1}. ${t}`).join(' ');
        const ans = `A strong answer should explain ${mainTopic} with evidence, and cover: ${points || 'key ideas from the text'}.`;
        return {
          correctAnswer: '',
          explanation: 'Answers may vary; credit clarity, accuracy, and coverage of key ideas.',
          answer: ans
        };
      }

      if (question.type === QUESTION_TYPES.FILL_BLANK) {
        return {
          correctAnswer: question.correctAnswer || mainTopic,
          explanation: `The blank refers to ${mainTopic} as emphasized in the content.`,
          answer: question.correctAnswer || mainTopic
        };
      }

      return { correctAnswer: question.correctAnswer || '', explanation: question.explanation || '', answer: question.answer || '' };
    } catch (_) {
      return { correctAnswer: question.correctAnswer || '', explanation: question.explanation || '', answer: question.answer || '' };
    }
  }

  // Ensure every question has an 'answer' populated
  ensureAnswers(questions) {
    return (questions || []).map((q) => {
      const cloned = { ...q };
      if (!cloned.answer) {
        // Prefer explicit correctAnswer
        let ans = cloned.correctAnswer || '';
        // If MCQ and correctAnswer might be a letter, map to option text
        if (
          (!ans || ans.length <= 2) &&
          cloned.type === QUESTION_TYPES.MULTIPLE_CHOICE &&
          Array.isArray(cloned.options) && cloned.options.length > 0
        ) {
          const letter = (ans || '').trim().toUpperCase();
          const letterIndex = letter >= 'A' && letter <= 'Z' ? letter.charCodeAt(0) - 65 : -1;
          if (letterIndex >= 0 && letterIndex < cloned.options.length) {
            ans = cloned.options[letterIndex];
          } else if (!ans) {
            // Fallback to first option if not specified
            ans = cloned.options[0];
          }
        }
        // As final fallback, synthesize from explanation or content
        if (!ans && cloned.explanation) {
          ans = cloned.explanation.split(/\n|\./)[0].trim();
        }
        cloned.answer = ans || '';
      }
      return cloned;
    });
  }

  generateSummaryTable(questions) {
    const summary = {};
    
    Object.keys(BLOOM_LEVELS).forEach(level => {
      const levelQuestions = questions.filter(q => q.bloomLevel === level);
      summary[level] = {
        count: levelQuestions.length,
        marks: levelQuestions.reduce((sum, q) => sum + q.marks, 0),
        code: BLOOM_LEVELS[level].code
      };
    });

    return summary;
  }
}

// Routes
app.post('/api/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const sessionId = uuidv4();
    const generator = new AIQuestionGenerator();
    
    // Extract content from uploaded file
    await generator.extractContent(req.file.path, req.file.mimetype);
    
    // Store session data
    const sessionData = {
      sessionId,
      filePath: req.file.path,
      content: generator.content,
      visualElements: generator.visualElements,
      timestamp: new Date()
    };

    // Store in session storage
    sessionStorage.set(sessionId, sessionData);

    // Clean up file after 1 hour
    setTimeout(async () => {
      try {
        await fs.remove(req.file.path);
        sessionStorage.delete(sessionId);
      } catch (error) {
        console.error('Error cleaning up file:', error);
      }
    }, 60 * 60 * 1000); // 1 hour

    res.json({
      sessionId,
      message: 'File uploaded and processed successfully',
      contentLength: generator.content.length,
      visualElementsCount: generator.visualElements.length
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Error processing file' });
  }
});

// Multiple document upload route
app.post('/api/upload-multiple', multiUpload.array('documents', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const sessionId = uuidv4();
    const generator = new AIQuestionGenerator();
    
    const uploadedDocs = [];
    
    // Process each uploaded file
    for (const file of req.files) {
      try {
        const documentData = await generator.addDocument(file.path, file.mimetype, file.originalname);
        uploadedDocs.push({
          id: documentData.id,
          fileName: documentData.fileName,
          contentLength: documentData.content.length,
          fileType: documentData.fileType
        });
      } catch (error) {
        console.error(`Error processing file ${file.originalname}:`, error);
        // Continue with other files even if one fails
      }
    }
    
    // Store multi-document session data
    const sessionData = {
      sessionId,
      documents: uploadedDocs,
      generator: generator,
      timestamp: new Date()
    };

    multiDocSessions.set(sessionId, sessionData);

    // Clean up files after 1 hour
    setTimeout(async () => {
      try {
        for (const file of req.files) {
          await fs.remove(file.path);
        }
        multiDocSessions.delete(sessionId);
      } catch (error) {
        console.error('Error cleaning up files:', error);
      }
    }, 60 * 60 * 1000); // 1 hour

    res.json({
      sessionId,
      message: 'Multiple documents uploaded and processed successfully',
      documents: uploadedDocs,
      totalDocuments: uploadedDocs.length,
      totalContentLength: generator.content.length
    });

  } catch (error) {
    console.error('Multiple upload error:', error);
    res.status(500).json({ error: 'Error processing multiple files' });
  }
});

// Add document to existing session
app.post('/api/add-document/:sessionId', upload.single('document'), async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const sessionData = multiDocSessions.get(sessionId);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const documentData = await sessionData.generator.addDocument(
      req.file.path, 
      req.file.mimetype, 
      req.file.originalname
    );

    // Update session data
    sessionData.documents.push({
      id: documentData.id,
      fileName: documentData.fileName,
      contentLength: documentData.content.length,
      fileType: documentData.fileType
    });

    res.json({
      message: 'Document added successfully',
      document: {
        id: documentData.id,
        fileName: documentData.fileName,
        contentLength: documentData.content.length,
        fileType: documentData.fileType
      },
      totalDocuments: sessionData.documents.length
    });

  } catch (error) {
    console.error('Add document error:', error);
    res.status(500).json({ error: 'Error adding document' });
  }
});

// Get documents in a session
app.get('/api/documents/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionData = multiDocSessions.get(sessionId);
    
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      sessionId,
      documents: sessionData.documents,
      totalDocuments: sessionData.documents.length,
      totalContentLength: sessionData.generator.content.length
    });

  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ error: 'Error retrieving documents' });
  }
});

app.post('/api/generate-questions', async (req, res) => {
  try {
    const { sessionId, requirements } = req.body;
    
    // Check both single and multi-document sessions
    let sessionData = sessionStorage.get(sessionId);
    let isMultiDoc = false;
    
    if (!sessionData) {
      sessionData = multiDocSessions.get(sessionId);
      isMultiDoc = true;
    }
    
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found. Please upload a document first.' });
    }
    
    let generator;
    if (isMultiDoc) {
      generator = sessionData.generator;
    } else {
      generator = new AIQuestionGenerator();
      generator.content = sessionData.content;
      generator.visualElements = sessionData.visualElements;
    }
    
    // Generate questions based on actual content
    const questions = await generator.generateQuestions(requirements);
    
    res.json({
      questions,
      totalQuestions: questions.length,
      totalMarks: questions.reduce((sum, q) => sum + q.marks, 0),
      isMultiDocument: isMultiDoc,
      documentCount: isMultiDoc ? sessionData.documents.length : 1
    });

  } catch (error) {
    console.error('Question generation error:', error);
    res.status(500).json({ error: 'Error generating questions' });
  }
});

// AI Status endpoint
app.get('/api/ai-status', async (req, res) => {
  try {
    console.log('Environment variable check:', {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET',
      GEMINI_API_KEY_VALUE: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 10) + '...' : 'NONE'
    });
    
    if (!GEMINI_API_KEY || !genAI) {
      return res.json({
        available: false,
        message: 'Gemini API key not configured. Please set GEMINI_API_KEY in your .env file.'
      });
    }

    // Test the API key with a simple request
    try {
      console.log('Testing Gemini API with model: gemini-1.5-flash');
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      console.log('Model created successfully');
      
      const result = await model.generateContent("Hello");
      console.log('Content generated successfully');
      await result.response;
      console.log('Response processed successfully');
      
      res.json({
        available: true,
        message: 'AI (Gemini) is ready'
      });
    } catch (error) {
      console.error('Gemini API test error:', error);
      res.json({
        available: false,
        message: 'Invalid API key or API error: ' + error.message
      });
    }
  } catch (error) {
    res.json({
      available: false,
      message: 'Error checking AI status: ' + error.message
    });
  }
});

// Test AI question generation with sample content
app.post('/api/test-ai-generation', async (req, res) => {
  try {
    const { content, requirements } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: 'No content provided' });
    }
    
    const generator = new AIQuestionGenerator();
    generator.content = content;
    
    console.log('Testing AI generation with content length:', content.length);
    console.log('Content preview:', content.substring(0, 200) + '...');
    
    const questions = await generator.generateQuestions({
      ...requirements,
      useAI: true
    });
    
    res.json({
      success: true,
      questions,
      contentLength: content.length,
      contentPreview: content.substring(0, 200) + '...'
    });
    
  } catch (error) {
    console.error('Test AI generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug route to check content analysis
app.get('/api/analyze-content/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionData = sessionStorage.get(sessionId);
    
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const generator = new AIQuestionGenerator();
    generator.content = sessionData.content;
    
    // Analyze content
    const words = sessionData.content.toLowerCase().match(/\b\w+\b/g) || [];
    const wordFreq = {};
    words.forEach(word => {
      if (word.length > 3) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    });
    
    const keyTerms = Object.entries(wordFreq)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 20);
    
    res.json({
      contentLength: sessionData.content.length,
      contentPreview: sessionData.content.substring(0, 500) + '...',
      keyTerms,
      totalWords: words.length,
      uniqueWords: Object.keys(wordFreq).length
    });
    
  } catch (error) {
    console.error('Content analysis error:', error);
    res.status(500).json({ error: 'Error analyzing content' });
  }
});

app.post('/api/generate-exam-paper', async (req, res) => {
  try {
    const { sessionId, questions, examConfig } = req.body;
    
    // Check both single and multi-document sessions
    let sessionData = sessionStorage.get(sessionId);
    let isMultiDoc = false;
    
    if (!sessionData) {
      sessionData = multiDocSessions.get(sessionId);
      isMultiDoc = true;
    }
    
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found. Please upload a document first.' });
    }
    
    let generator;
    if (isMultiDoc) {
      generator = sessionData.generator;
    } else {
      generator = new AIQuestionGenerator();
      generator.content = sessionData.content;
      generator.visualElements = sessionData.visualElements;
    }
    
    const examPaper = generator.generateExamPaper(questions, examConfig);
    
    res.json({
      examPaper,
      message: 'Exam paper generated successfully',
      isMultiDocument: isMultiDoc,
      documentCount: isMultiDoc ? sessionData.documents.length : 1
    });

  } catch (error) {
    console.error('Exam paper generation error:', error);
    res.status(500).json({ error: 'Error generating exam paper' });
  }
});

app.post('/api/export-pdf', async (req, res) => {
  try {
    const { examPaper } = req.body;
    
    console.log('PDF Export: Starting PDF generation...');
    console.log('PDF Export: Exam paper structure:', JSON.stringify(examPaper, null, 2));
    
    if (!examPaper) {
      throw new Error('No exam paper data provided');
    }
    
    // Generate HTML content for the exam paper
    const htmlContent = generateExamPaperHTML(examPaper);
    console.log('PDF Export: HTML content generated, length:', htmlContent.length);
    
    // Launch Puppeteer with Windows-compatible settings
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
    
    console.log('PDF Export: Browser launched successfully');
    const page = await browser.newPage();
    console.log('PDF Export: New page created');
    
    // Set content and wait for it to load
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    console.log('PDF Export: Content set on page');
    
    // Generate PDF with better settings
    console.log('PDF Export: Generating PDF...');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: {
        top: '20mm',
        right: '20mm',
        bottom: '20mm',
        left: '20mm'
      },
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: false,
      scale: 1.0
    });
    
    console.log('PDF Export: PDF generated successfully, buffer size:', pdfBuffer.length);
    
    // Simple size check - if it's large enough, it's probably valid
    if (pdfBuffer.length < 100) {
      throw new Error('Generated PDF is too small, may be invalid');
    }
    
    console.log('PDF Export: PDF validation passed - proceeding with download');
    
    await browser.close();
    console.log('PDF Export: Browser closed');
    
    // Set response headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="exam-paper-${Date.now()}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('PDF export error:', error);
    
    // Try fallback method - return HTML content for manual download
    try {
      console.log('PDF Export: Attempting fallback to HTML download...');
      const htmlContent = generateExamPaperHTML(req.body.examPaper);
      
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `attachment; filename="exam-paper-${Date.now()}.html"`);
      res.setHeader('Cache-Control', 'no-cache');
      res.send(htmlContent);
    } catch (fallbackError) {
      console.error('PDF export fallback error:', fallbackError);
      res.status(500).json({ 
        error: 'Error generating PDF',
        details: error.message,
        suggestion: 'Please try again or contact support'
      });
    }
  }
});

// Function to generate HTML content for the exam paper
function generateExamPaperHTML(examPaper) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${examPaper.header.institutionName} - Exam Paper</title>
      <style>
        @page {
          size: A4;
          margin: 20mm;
        }
        body {
          font-family: 'Times New Roman', serif;
          line-height: 1.6;
          margin: 0;
          padding: 0;
          color: #333;
          font-size: 12pt;
        }
        .header {
          text-align: center;
          border-bottom: 2px solid #333;
          padding-bottom: 20px;
          margin-bottom: 30px;
        }
        .institution-name {
          font-size: 18px;
          font-weight: bold;
          margin-bottom: 10px;
        }
        .course-details {
          font-size: 14px;
          margin-bottom: 5px;
        }
        .exam-info {
          display: flex;
          justify-content: space-between;
          margin: 20px 0;
          font-size: 12px;
        }
        .section {
          margin-bottom: 30px;
        }
        .section-title {
          font-size: 16px;
          font-weight: bold;
          margin-bottom: 15px;
          border-bottom: 1px solid #ccc;
          padding-bottom: 5px;
        }
        .question {
          margin-bottom: 20px;
          page-break-inside: avoid;
        }
        .question-number {
          font-weight: bold;
          margin-bottom: 5px;
        }
        .question-text {
          margin-bottom: 10px;
        }
        .options {
          margin-left: 20px;
        }
        .option {
          margin-bottom: 5px;
        }
        .marks {
          font-weight: bold;
          color: #666;
        }
        .summary-table {
          margin-top: 40px;
          border-collapse: collapse;
          width: 100%;
          font-size: 12px;
        }
        .summary-table th,
        .summary-table td {
          border: 1px solid #ccc;
          padding: 8px;
          text-align: center;
        }
        .summary-table th {
          background-color: #f5f5f5;
          font-weight: bold;
        }
        .page-break {
          page-break-before: always;
        }
        @media print {
          body { margin: 0; }
          .page-break { page-break-before: always; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="institution-name">${examPaper.header.institutionName}</div>
        <div class="course-details">${examPaper.header.courseName}</div>
        <div class="course-details">${examPaper.header.courseCode}</div>
        <div class="course-details">${examPaper.header.examSession}</div>
      </div>
      
      <div class="exam-info">
        <div>Duration: ${examPaper.header.duration}</div>
        <div>Date: ${examPaper.header.date}</div>
        <div>Max Marks: ${examPaper.header.maxMarks}</div>
      </div>
      
      ${examPaper.parts.map((part, partIndex) => `
        <div class="section">
          <div class="section-title">${part.name} ${part.description}</div>
          ${part.questions.map((question, questionIndex) => `
            <div class="question">
              <div class="question-number">${partIndex + 1}.${questionIndex + 1} ${question.content} <span class="marks">[${question.marks} marks]</span></div>
              ${question.options && question.options.length > 0 ? `
                <div class="options">
                  ${question.options.map((option, optionIndex) => `
                    <div class="option">${String.fromCharCode(65 + optionIndex)}. ${option}</div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `).join('')}
      
      <div class="page-break"></div>
      
      <div class="section">
        <div class="section-title">Summary Table</div>
        <table class="summary-table">
          <thead>
            <tr>
              <th>Bloom's Taxonomy Level</th>
              <th>Course Outcome</th>
              <th>Number of Questions</th>
              <th>Total Marks</th>
            </tr>
          </thead>
          <tbody>
            ${Object.entries(examPaper.summary).map(([level, data]) => `
              <tr>
                <td>${BLOOM_LEVELS[level].name}</td>
                <td>${data.code}</td>
                <td>${data.count}</td>
                <td>${data.marks}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `;
}

// Test PDF generation route
app.get('/api/test-pdf', async (req, res) => {
  try {
    console.log('Test PDF: Starting simple PDF generation...');
    
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    await page.setContent('<html><body><h1>Test PDF</h1><p>This is a test PDF generated successfully!</p></body></html>');
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
      printBackground: true
    });
    
    await browser.close();
    
    console.log('Test PDF: Generated successfully, size:', pdfBuffer.length);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="test.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('Test PDF error:', error);
    res.status(500).json({ error: 'Test PDF generation failed: ' + error.message });
  }
});

// Socket.IO for real-time collaboration
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-session', (sessionId) => {
    socket.join(sessionId);
    console.log(`User ${socket.id} joined session ${sessionId}`);
  });

  socket.on('question-update', (data) => {
    socket.to(data.sessionId).emit('question-updated', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`AI Question Generator server running on port ${PORT}`);
});
