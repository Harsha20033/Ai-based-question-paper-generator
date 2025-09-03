# SmallPDF AI Question Generator

An advanced AI-powered question generator designed to create quizzes, tests, and structured exam papers from uploaded PDF documents, targeting educators, students, and professionals, with questions aligned to Bloom's Taxonomy (Revised).

## 🌟 Features

### Core Functionality
- **Multi-format Document Support**: Upload PDF, Word, PowerPoint, Excel, and image files
- **OCR Integration**: Extract text from scanned documents and images
- **Bloom's Taxonomy Integration**: Generate questions across all 6 cognitive levels
- **Structured Exam Papers**: Create professional exam papers with course details
- **Real-time Collaboration**: Work together with team members in real-time

### Question Generation
- **Multiple Question Types**: Multiple choice, true/false, short answer, essay, fill-in-the-blank
- **Adaptive Difficulty**: Easy, medium, and hard difficulty levels
- **Customizable Distribution**: Balanced, foundational, or advanced Bloom's Taxonomy distribution
- **Marks Allocation**: Automatic marks calculation based on question type and difficulty

### Exam Paper Features
- **Professional Format**: University-style exam paper layout
- **Course Details**: Institution name, course code, semester, duration, etc.
- **Part-wise Organization**: Structured into Part A and Part B with mark distribution
- **Summary Table**: Bloom's Taxonomy mapping with course outcomes (COs)
- **Export Options**: Print and PDF export capabilities

### Advanced Features
- **Gamification**: Points and badges for higher Bloom's levels
- **Adaptive Learning**: Dynamic difficulty adjustment based on performance
- **Study Guides**: Generate study materials by Bloom's Taxonomy level
- **LMS Integration**: Export to Canvas, Moodle, and other platforms
- **Security**: TLS encryption, GDPR compliance, auto-file deletion

## 🚀 Quick Start

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn package manager

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/smallpdf-ai-question-generator.git
   cd smallpdf-ai-question-generator
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm run dev
   ```

4. **Open your browser**
   Navigate to `http://localhost:3000`

### Production Deployment

1. **Build the application**
   ```bash
   npm run build
   ```

2. **Start the production server**
   ```bash
   npm start
   ```

## 📖 Usage Guide

### 1. Upload Document
1. Click on the "Upload Document" tab
2. Drag and drop your file or click "Choose File"
3. Supported formats: PDF, DOC, PPT, XLS, JPG, PNG
4. Maximum file size: 50MB
5. Wait for processing to complete

### 2. Generate Questions
1. Navigate to the "Generate Questions" tab
2. Configure your settings:
   - **Total Marks**: Set the total marks for the exam
   - **Number of Questions**: Choose how many questions to generate
   - **Difficulty Level**: Select easy, medium, or hard
   - **Bloom's Taxonomy Distribution**: Choose balanced, foundational, or advanced
   - **Question Types**: Select the types of questions you want
3. Click "Generate Questions"
4. Review and edit questions as needed

### 3. Create Exam Paper
1. Go to the "Create Exam Paper" tab
2. Fill in the exam details:
   - Institution name
   - Course code and name
   - Degree and semester
   - Exam session and duration
   - Maximum marks
3. Click "Generate Exam Paper"
4. Preview, print, or export the exam paper

## 🧠 Bloom's Taxonomy Integration

The application generates questions across all six levels of Bloom's Taxonomy:

| Level | Code | Description | Question Examples |
|-------|------|-------------|-------------------|
| **Remember** | CO1 | Recall facts and basic concepts | "What is the definition of...?" |
| **Understand** | CO2 | Explain ideas and concepts | "Explain in your own words..." |
| **Apply** | CO3 | Use information in new situations | "How would you apply...?" |
| **Analyze** | CO4 | Draw connections among ideas | "Analyze the differences between..." |
| **Evaluate** | CO5 | Justify a stand or decision | "Evaluate the effectiveness of..." |
| **Create** | CO6 | Produce new or original work | "Design a solution for..." |

### Distribution Options

- **Balanced**: Equal distribution across all levels (20% each for Remember/Understand/Apply, 15% each for Analyze/Evaluate, 10% for Create)
- **Foundational**: Focus on Remember and Understand levels (40% Remember, 30% Understand, 20% Apply, 10% Analyze)
- **Advanced**: Focus on higher-order thinking (10% Remember, 15% Understand, 20% Apply, 25% Analyze, 20% Evaluate, 10% Create)

## 🏗️ Architecture

### Backend (Node.js/Express)
- **File Processing**: PDF parsing, OCR, image extraction
- **AI Question Generation**: Content analysis and question creation
- **Real-time Communication**: Socket.IO for collaboration
- **Security**: Rate limiting, file validation, auto-cleanup

### Frontend (Vanilla JavaScript)
- **Modern UI**: Responsive design with CSS Grid and Flexbox
- **Interactive Features**: Drag-and-drop, real-time updates
- **Accessibility**: Keyboard shortcuts, screen reader support
- **Cross-browser**: Works on all modern browsers

### Key Technologies
- **Server**: Express.js, Socket.IO
- **File Processing**: pdf-parse, tesseract.js, pdf2pic
- **Security**: Helmet, CORS, rate limiting
- **Frontend**: Vanilla JS, CSS3, HTML5

## 🔧 Configuration

### Environment Variables
Create a `.env` file in the root directory:

```env
PORT=3000
NODE_ENV=development
MAX_FILE_SIZE=52428800
FILE_CLEANUP_DELAY=3600000
```

### Customization Options

#### Question Generation
```javascript
// Customize question templates
const questionTemplates = {
  REMEMBER: {
    'multiple-choice': 'Which of the following is a key concept mentioned in the text?',
    'true-false': 'Based on the text, is the following statement true or false?'
  }
  // ... more templates
};
```

#### Exam Paper Format
```javascript
// Customize exam paper structure
const examConfig = {
  institutionName: 'Your Institution',
  courseCode: 'CS101',
  courseName: 'Computer Science Fundamentals',
  // ... more settings
};
```

## 🔒 Security Features

- **File Validation**: Type and size checking
- **Rate Limiting**: 100 requests per 15 minutes per IP
- **Auto-cleanup**: Files deleted after 1 hour
- **CORS Protection**: Configured for secure cross-origin requests
- **Input Sanitization**: All user inputs are validated and sanitized

## 📊 API Endpoints

### POST `/api/upload`
Upload and process a document
```javascript
// Request
FormData: {
  document: File
}

// Response
{
  sessionId: "uuid",
  message: "File uploaded and processed successfully",
  contentLength: 1500,
  visualElementsCount: 3
}
```

### POST `/api/generate-questions`
Generate questions based on requirements
```javascript
// Request
{
  sessionId: "uuid",
  requirements: {
    totalMarks: 50,
    questionCount: 10,
    difficulty: "medium",
    bloomDistribution: "balanced",
    questionTypes: ["multiple-choice", "essay"]
  }
}

// Response
{
  questions: [...],
  totalQuestions: 10,
  totalMarks: 50
}
```

### POST `/api/generate-exam-paper`
Generate structured exam paper
```javascript
// Request
{
  sessionId: "uuid",
  questions: [...],
  examConfig: {
    institutionName: "University Name",
    courseCode: "CS101",
    // ... more config
  }
}

// Response
{
  examPaper: {
    header: {...},
    parts: [...],
    summary: {...}
  }
}
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Follow the existing code style
- Add tests for new features
- Update documentation as needed
- Ensure all tests pass before submitting

## 🧪 Testing

Run the test suite:
```bash
npm test
```

Run tests in watch mode:
```bash
npm run test:watch
```


## 🙏 Acknowledgments

- Bloom's Taxonomy framework for educational assessment
- Open source libraries and tools used in this project
- Educational institutions for feedback and testing



## 🔄 Changelog

### v1.0.0 (2024-01-01)
- Initial release
- PDF document processing
- Bloom's Taxonomy question generation
- Exam paper creation
- Real-time collaboration
- Modern responsive UI

---

**Made with ❤️ for educators and students worldwide**
