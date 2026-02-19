/**
 * Polsa Grant Backend
 *
 * This server handles airtime top-up requests, acting as a secure proxy
 * to the airtime provider's API. It manages API keys, validates requests,
 * and provides clear feedback to the frontend client.
 */

// 1. Import Dependencies
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// 2. Initialize Express App and Configuration
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '67023380ece9a9561cac9b5f208907e0ab85063b';
const AIRTIME_API_URL = 'https://maskawasub.com/api/topup/';

// Admin & Site State (In-Memory)
const ADMIN_PIN = '226688';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '09161041419';
let siteState = {
	isSiteOnline: true,
	claimLimit: 52, // Default value from frontend logic
	claimsToday: 0,
};
let transactionHistory = [];


// 3. Apply Middleware

// Enable CORS for all origins. For production, you might want to restrict this
// to your frontend's domain: app.use(cors({ origin: 'https://your-frontend-domain.com' }));
app.use(cors());

// Parse incoming JSON requests
app.use(express.json());

// Admin Router (bypasses rate limiting)
const adminRouter = express.Router();

// Middleware to verify admin PIN for protected routes
const verifyAdminPin = (req, res, next) => {
    const { pin } = req.body;
    if (pin !== ADMIN_PIN) {
        return res.status(403).json({ success: false, message: 'Invalid admin PIN.' });
    }
    next();
};

// Admin login (doesn't need PIN verification)
adminRouter.post('/login', (req, res) => {
    const { pin } = req.body;
    if (pin === ADMIN_PIN) {
        res.status(200).json({ success: true, message: 'Login successful.' });
    } else {
        res.status(401).json({ success: false, message: 'Invalid PIN.' });
    }
});

// All other admin routes are protected by the PIN
adminRouter.use(verifyAdminPin);

// Get current site state
adminRouter.post('/state', (req, res) => {
    // Calculate total amount dispensed today
    const today = new Date().toISOString().split('T')[0];
    const totalAmountToday = transactionHistory
        .filter(tx => tx.date.startsWith(today) && (tx.status === 'Success' || tx.status === 'Success (Admin)'))
        .reduce((sum, tx) => sum + tx.amount, 0);

    // Add to siteState for frontend
    siteState.totalAmountToday = totalAmountToday;

    res.status(200).json({ success: true, state: siteState });
});

// Get transaction history
adminRouter.post('/history', (req, res) => {
    res.status(200).json({ success: true, history: transactionHistory });
});

// Toggle site ON/OFF
adminRouter.post('/toggle-site', (req, res) => {
    siteState.isSiteOnline = !siteState.isSiteOnline;
    console.log(`[Admin] Site status toggled to: ${siteState.isSiteOnline ? 'ON' : 'OFF'}`);
    res.status(200).json({ success: true, message: `Site is now ${siteState.isSiteOnline ? 'ON' : 'OFF'}.`, state: siteState });
});

// Set new claim limit
adminRouter.post('/set-limit', (req, res) => {
    const { limit } = req.body;
    const newLimit = parseInt(limit, 10);
    if (isNaN(newLimit) || newLimit < 0) {
        return res.status(400).json({ success: false, message: 'Invalid limit provided. Must be a non-negative number.' });
    }
    siteState.claimLimit = newLimit;
    console.log(`[Admin] Claim limit set to: ${siteState.claimLimit}`);
    res.status(200).json({ success: true, message: `Claim limit updated to ${newLimit}.`, state: siteState });
});

// Reset claim count
adminRouter.post('/reset-count', (req, res) => {
    siteState.claimsToday = 0;
    console.log(`[Admin] Claim count reset to 0.`);
    res.status(200).json({ success: true, message: 'Claim count has been reset.', state: siteState });
});

// Admin-specific airtime sending (bypasses all user checks)
adminRouter.post('/send-airtime', async (req, res) => {
    const { network, mobile_number } = req.body;
	if (!network || !mobile_number) return res.status(400).json({ success: false, message: 'Missing required fields: network and mobile_number.' });

	const networkIds = { 'MTN': 1, 'Glo': 2, '9mobile': 3, 'Airtel': 4 };
	const apiPayload = { network: networkIds[network], mobile_number, amount: 100, airtime_type: "VTU", Ported_number: true };
	const apiHeaders = { 'Content-Type': 'application/json', 'Authorization': `Token ${API_KEY}` };

    try {
        console.log(`[Admin Send] Attempting to send ₦100 airtime to ${mobile_number} on ${network}.`);
		const apiResponse = await axios.post(AIRTIME_API_URL, apiPayload, { headers: apiHeaders });
        console.log(`[Admin Success] Airtime sent to ${mobile_number}. Provider Response:`, apiResponse.data);
        
        // Log to history
        transactionHistory.unshift({
            date: new Date().toISOString(),
            network, mobile_number, amount: 100, status: 'Success (Admin)'
        });

		res.status(200).json({ success: true, message: `Admin send successful: ${apiResponse.data.message || 'Airtime request processed.'}`, data: apiResponse.data });
    } catch (error) {
        const statusCode = error.response ? error.response.status : 500;
        const errorMessage = error.response ? (error.response.data.detail || error.response.data.message) : 'An internal error occurred.';
        console.error(`[Admin Send Error] Status ${statusCode} for ${mobile_number}. Message: ${errorMessage}`);
        res.status(statusCode).json({ success: false, message: errorMessage });
    }
});

app.use('/admin', adminRouter);

// Apply a rate limiter to all requests to prevent abuse
const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100, // Limit each IP to 100 requests per window
	standardHeaders: true,
	legacyHeaders: false,
	message: 'Too many requests from this IP, please try again after 15 minutes.',
});
app.use(limiter);


// 4. Define API Routes

/**
 * @route   GET /
 * @desc    Health check endpoint to confirm the backend is running.
 * @access  Public
 */
app.get('/', (req, res) => {
	res.status(200).json({ message: 'Polsa Grant Backend is running!' });
});

/**
 * @route   POST /send-airtime
 * @desc    Processes an airtime top-up request.
 * @access  Public (protected by rate limiting)
 */
app.post('/send-airtime', async (req, res) => {
	const { network, mobile_number } = req.body;

	// Server-side validation for non-admin users
	const isAdminRequest = mobile_number === ADMIN_PHONE;
	if (!isAdminRequest) {
		if (!siteState.isSiteOnline) {
			return res.status(503).json({ success: false, message: 'Site is currently unavailable. Please try later.' });
		}
		if (siteState.claimsToday >= siteState.claimLimit) {
			return res.status(429).json({ success: false, message: 'The daily airtime claim limit has been reached. Please try again later.' });
		}
	}

	// A. Input Validation
	if (!network || !mobile_number) {
		return res.status(400).json({ success: false, message: 'Missing required fields: network and mobile_number.' });
	}

	// Basic validation for Nigerian phone number format
	const phoneRegex = /^0(70|80|81|90|91)\d{8}$/;
	if (!phoneRegex.test(mobile_number)) {
		return res.status(400).json({ success: false, message: 'Invalid phone number format. Please provide an 11-digit Nigerian number.' });
	}

	// B. Server Configuration Check
	if (!API_KEY) {
		console.error('FATAL: API_KEY is not configured on the server.');
		return res.status(500).json({ success: false, message: 'Server configuration error. Unable to process request.' });
	}

	// C. Prepare Data for External API
	const networkIds = { 'MTN': 1, 'Glo': 2, '9mobile': 3, 'Airtel': 4 };
	const apiPayload = {
		network: networkIds[network],
		mobile_number: mobile_number,
		amount: 100, // Fixed amount as per project requirements
		airtime_type: "VTU",
		Ported_number: true,
	};

	const apiHeaders = {
		'Content-Type': 'application/json',
		'Authorization': `Token ${API_KEY}`,
	};

	// D. Execute API Call and Handle Response
	try {
		console.log(`[Request] Attempting to send ₦100 airtime to ${mobile_number} on ${network}.`);

		const apiResponse = await axios.post(AIRTIME_API_URL, apiPayload, { headers: apiHeaders });

		// The external API call was successful (2xx status code)
		console.log(`[Success] Airtime sent to ${mobile_number}. Provider Response:`, apiResponse.data);

		// Increment claim count for non-admins on success
		if (!isAdminRequest) {
			siteState.claimsToday++;
			console.log(`[State] Claim count incremented. Total: ${siteState.claimsToday}/${siteState.claimLimit}`);
		}

        // Log to history
        transactionHistory.unshift({
            date: new Date().toISOString(),
            network, mobile_number, amount: 100, status: 'Success'
        });

		// Respond to our client with the success message from the provider
		res.status(200).json({
			success: true,
			message: apiResponse.data.message || 'Airtime request processed successfully!',
			data: apiResponse.data,
		});

	} catch (error) {
		// Handle various types of errors from the axios request
		if (error.response) {
			// The request was made and the provider responded with a non-2xx status code
			const statusCode = error.response.status;
			const errorMessage = error.response.data.detail || error.response.data.message || 'An error occurred with the airtime provider.';
			console.error(`[Provider Error] Status ${statusCode} for ${mobile_number}. Message: ${errorMessage}`);
			res.status(statusCode).json({ success: false, message: errorMessage });
		} else if (error.request) {
			// The request was made but no response was received (e.g., timeout, network issue)
			console.error(`[Network Error] No response received from airtime provider for request to ${mobile_number}.`);
			res.status(503).json({ success: false, message: 'Airtime provider is unreachable. Please try again later.' });
		} else {
			// Something else went wrong in setting up the request
			console.error('[Internal Error] Error setting up the request:', error.message);
			res.status(500).json({ success: false, message: 'An internal server error occurred.' });
		}
	}
});


// 5. Start the Server
app.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`);
	if (!API_KEY) {
		console.warn('****************************************************');
		console.warn('** WARNING: API_KEY environment variable is not set! **');
		console.warn('** Airtime API calls will fail until it is configured. **');
		console.warn('****************************************************');
	}
});
