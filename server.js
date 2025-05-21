import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Routes
import entryRoutes from './routes/device.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Device Router
app.use('/iot/entry', entryRoutes);

// Basic route
app.get('/', (req, res) => {
  res.send('Hello, Express!');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});