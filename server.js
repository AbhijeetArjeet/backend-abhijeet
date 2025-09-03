const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to PostgreSQL:', err);
  } else {
    console.log('Connected to PostgreSQL database');
    release();
  }
});

// API Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'NFC Attendance API is running' });
});

// Get all sections
app.get('/api/sections', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sections ORDER BY section_name');
    res.json({ success: true, sections: result.rows });
  } catch (error) {
    console.error('Error fetching sections:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch sections' });
  }
});

// Verify attendance - check RFID tags against database
app.post('/api/verify-attendance', async (req, res) => {
  try {
    const { rfid_tags, classroom_id = 1 } = req.body;
    
    if (!rfid_tags || !Array.isArray(rfid_tags)) {
      return res.status(400).json({ success: false, error: 'Invalid RFID tags array' });
    }

    // Query to find students with matching RFID tags
    const query = `
      SELECT p.person_id, p.name, p.rfid_tag, p.id_number, s.section_name
      FROM persons p
      LEFT JOIN student_sections ss ON p.person_id = ss.person_id
      LEFT JOIN sections s ON ss.section_id = s.section_id
      WHERE p.rfid_tag = ANY($1) AND p.role = 'student'
    `;
    
    const result = await pool.query(query, [rfid_tags]);
    const verifiedStudents = result.rows;
    
    // Find unrecognized tags
    const foundTags = verifiedStudents.map(student => student.rfid_tag);
    const unrecognizedTags = rfid_tags.filter(tag => !foundTags.includes(tag));
    
    // Log attendance for verified students
    const attendancePromises = verifiedStudents.map(student => {
      return pool.query(
        'INSERT INTO attendance (person_id, classroom_id, timestamp) VALUES ($1, $2, NOW())',
        [student.person_id, classroom_id]
      );
    });
    
    await Promise.all(attendancePromises);
    
    res.json({
      success: true,
      total_scans: rfid_tags.length,
      verified_students: verifiedStudents.map(student => ({
        name: student.name,
        section: student.section_name || 'Unknown',
        rfid_tag: student.rfid_tag,
        id_number: student.id_number,
        status: 'Present'
      })),
      unrecognized: unrecognizedTags,
      message: `${verifiedStudents.length} students verified, ${unrecognizedTags.length} unrecognized tags`
    });
    
  } catch (error) {
    console.error('Error verifying attendance:', error);
    res.status(500).json({ success: false, error: 'Failed to verify attendance' });
  }
});

// Add new student
app.post('/api/add-student', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { name, rfid_tag, section, id_number } = req.body;
    
    // Validate input
    if (!name || !rfid_tag || !section || !id_number) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: name, rfid_tag, section, id_number' 
      });
    }
    
    // Check if RFID tag already exists
    const existingTag = await client.query('SELECT person_id FROM persons WHERE rfid_tag = $1', [rfid_tag]);
    if (existingTag.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'RFID tag already exists' });
    }
    
    // Check if ID number already exists
    const existingId = await client.query('SELECT person_id FROM persons WHERE id_number = $1', [id_number]);
    if (existingId.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'ID number already exists' });
    }
    
    // Get or create section
    let sectionResult = await client.query('SELECT section_id FROM sections WHERE section_name = $1', [section]);
    let sectionId;
    
    if (sectionResult.rows.length === 0) {
      const newSection = await client.query(
        'INSERT INTO sections (section_name) VALUES ($1) RETURNING section_id',
        [section]
      );
      sectionId = newSection.rows[0].section_id;
    } else {
      sectionId = sectionResult.rows[0].section_id;
    }
    
    // Insert student into persons table
    const personResult = await client.query(
      'INSERT INTO persons (name, rfid_tag, role, id_number) VALUES ($1, $2, $3, $4) RETURNING person_id',
      [name, rfid_tag, 'student', id_number]
    );
    
    const personId = personResult.rows[0].person_id;
    
    // Link student to section
    await client.query(
      'INSERT INTO student_sections (person_id, section_id) VALUES ($1, $2)',
      [personId, sectionId]
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: `Student ${name} added successfully`,
      student: {
        person_id: personId,
        name,
        rfid_tag,
        section,
        id_number
      }
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding student:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      res.status(400).json({ success: false, error: 'Duplicate RFID tag or ID number' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to add student' });
    }
  } finally {
    client.release();
  }
});

// Get attendance records for a specific date/section
app.get('/api/attendance', async (req, res) => {
  try {
    const { date, section_name, classroom_id } = req.query;
    
    let query = `
      SELECT 
        a.attendance_id,
        a.timestamp,
        p.name,
        p.id_number,
        p.rfid_tag,
        s.section_name,
        c.room_number
      FROM attendance a
      JOIN persons p ON a.person_id = p.person_id
      LEFT JOIN student_sections ss ON p.person_id = ss.person_id
      LEFT JOIN sections s ON ss.section_id = s.section_id
      LEFT JOIN classrooms c ON a.classroom_id = c.classroom_id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (date) {
      query += ` AND DATE(a.timestamp) = $${paramCount}`;
      params.push(date);
      paramCount++;
    }
    
    if (section_name) {
      query += ` AND s.section_name = $${paramCount}`;
      params.push(section_name);
      paramCount++;
    }
    
    if (classroom_id) {
      query += ` AND a.classroom_id = $${paramCount}`;
      params.push(classroom_id);
      paramCount++;
    }
    
    query += ' ORDER BY a.timestamp DESC';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      records: result.rows,
      count: result.rows.length
    });
    
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch attendance records' });
  }
});

// Get student list
app.get('/api/students', async (req, res) => {
  try {
    const { section_name } = req.query;
    
    let query = `
      SELECT 
        p.person_id,
        p.name,
        p.rfid_tag,
        p.id_number,
        s.section_name
      FROM persons p
      LEFT JOIN student_sections ss ON p.person_id = ss.person_id
      LEFT JOIN sections s ON ss.section_id = s.section_id
      WHERE p.role = 'student'
    `;
    
    const params = [];
    
    if (section_name) {
      query += ' AND s.section_name = $1';
      params.push(section_name);
    }
    
    query += ' ORDER BY p.name';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      students: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch students' });
  }
});

// Initialize database tables (for first-time setup)
app.post('/api/init-db', async (req, res) => {
  try {
    // Create tables if they don't exist (using your SQL schema)
    const createTablesSQL = `
      -- Create persons table
      CREATE TABLE IF NOT EXISTS persons (
        person_id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        rfid_tag VARCHAR(100) UNIQUE NOT NULL,
        role VARCHAR(20) CHECK (role IN ('student', 'teacher')) NOT NULL,
        id_number VARCHAR(20) UNIQUE
      );

      -- Create sections table
      CREATE TABLE IF NOT EXISTS sections (
        section_id SERIAL PRIMARY KEY,
        section_name VARCHAR(50) UNIQUE NOT NULL
      );

      -- Create student_sections mapping
      CREATE TABLE IF NOT EXISTS student_sections (
        person_id INT REFERENCES persons(person_id) ON DELETE CASCADE,
        section_id INT REFERENCES sections(section_id) ON DELETE CASCADE,
        PRIMARY KEY (person_id, section_id)
      );

      -- Create teacher_sections mapping
      CREATE TABLE IF NOT EXISTS teacher_sections (
        person_id INT REFERENCES persons(person_id) ON DELETE CASCADE,
        section_id INT REFERENCES sections(section_id) ON DELETE CASCADE,
        PRIMARY KEY (person_id, section_id)
      );

      -- Create classrooms table
      CREATE TABLE IF NOT EXISTS classrooms (
        classroom_id SERIAL PRIMARY KEY,
        room_number VARCHAR(20) UNIQUE NOT NULL
      );

      -- Create schedule table
      CREATE TABLE IF NOT EXISTS schedule (
        schedule_id SERIAL PRIMARY KEY,
        section_id INT REFERENCES sections(section_id) ON DELETE CASCADE,
        teacher_id INT REFERENCES persons(person_id) ON DELETE CASCADE,
        classroom_id INT REFERENCES classrooms(classroom_id) ON DELETE CASCADE,
        day_of_week VARCHAR(10) CHECK (day_of_week IN 
          ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL
      );

      -- Create attendance table
      CREATE TABLE IF NOT EXISTS attendance (
        attendance_id SERIAL PRIMARY KEY,
        person_id INT REFERENCES persons(person_id) ON DELETE CASCADE,
        classroom_id INT REFERENCES classrooms(classroom_id) ON DELETE CASCADE,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Insert default classroom if none exists
      INSERT INTO classrooms (room_number) 
      SELECT 'Default Room' 
      WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE room_number = 'Default Room');

      -- Insert default sections
      INSERT INTO sections (section_name) 
      SELECT unnest(ARRAY['CS-A', 'CS-B', 'EE-A', 'EE-B', 'ME-A', 'ME-B'])
      WHERE NOT EXISTS (SELECT 1 FROM sections LIMIT 1);
    `;

    await pool.query(createTablesSQL);
    
    res.json({
      success: true,
      message: 'Database initialized successfully'
    });
    
  } catch (error) {
    console.error('Error initializing database:', error);
    res.status(500).json({ success: false, error: 'Failed to initialize database' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`NFC Attendance API server running on port ${PORT}`);
});
