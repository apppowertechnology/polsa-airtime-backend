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
const API_KEY = process.env.API_KEY;
const AIRTIME_API_URL = 'https://maskawasub.com/api/topup/';

// 3. Apply Middleware

// Enable CORS for all origins. For production, you might want to restrict this
// to your frontend's domain: app.use(cors({ origin: 'https://your-frontend-domain.com' }));
app.use(cors());

// Parse incoming JSON requests
app.use(express.json());

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
	// A. Input Validation
	const { network, mobile_number } = req.body;

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
