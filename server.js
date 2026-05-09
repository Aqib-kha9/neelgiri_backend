const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');

dotenv.config();

connectDB();

const app = express();

// CORS Configuration for Production
const corsOptions = {
    origin: [
        'https://delivery-beta-olive.vercel.app',
        'http://localhost:3000',
        'http://localhost:3001'
    ],
    credentials: true,
    optionsSuccessStatus: 200
};

// Middleware
app.use(express.json());
app.use(cors(corsOptions));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rbac', require('./routes/rbacRoutes'));
app.use('/api/drs', require('./routes/drsRoutes'));
app.use('/api/branches', require('./routes/branchRoutes'));
app.use('/api/shipments', require('./routes/shipmentRoutes'));
app.use('/api/manifests', require('./routes/manifestRoutes'));
app.use('/api/bags', require('./routes/bagRoutes'));
app.use('/api/customers', require('./routes/customerRoutes'));
app.use('/api/rates', require('./routes/rateRoutes'));
app.use('/api/pincodes', require('./routes/pincodeRoutes'));
app.use('/api/places', require('./routes/placesRoutes'));

app.get('/', (req, res) => {
    res.send('Delivery API is running...');
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
