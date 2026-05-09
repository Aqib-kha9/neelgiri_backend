exports.searchPlaces = async (req, res) => {
    try {
        console.log("\n--- [Backend Places API] Search Request Started ---");
        const { input } = req.query;
        console.log(`[Backend Places API] Input received: "${input}"`);
        
        if (!input) {
            console.log("[Backend Places API] Error: Input is required");
            return res.status(400).json({ message: "Input is required" });
        }

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            console.error("[Backend Places API] Error: Google Places API Key not configured in .env");
            return res.status(500).json({ message: "Google Places API Key not configured" });
        }
        console.log(`[Backend Places API] API Key found (starts with: ${apiKey.substring(0, 5)}..., length: ${apiKey.length})`);

        const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
        url.searchParams.append('input', input);
        url.searchParams.append('key', apiKey);
        url.searchParams.append('components', 'country:in');

        console.log(`[Backend Places API] Calling Google Maps API...`);
        const response = await fetch(url.toString());
        const data = await response.json();

        console.log(`[Backend Places API] Google API Response Status Code: ${response.status}`);
        if (data.status) {
            console.log(`[Backend Places API] Google API Internal Status: ${data.status}`);
            if (data.error_message) {
                console.error(`[Backend Places API] Google API Error Message: ${data.error_message}`);
            }
        }
        
        console.log(`[Backend Places API] Sending ${data.predictions ? data.predictions.length : 0} predictions back to frontend`);
        console.log("---------------------------------------------------\n");
        res.json(data);
    } catch (error) {
        console.error("[Backend Places API] Error searching places:", error);
        res.status(500).json({ message: "Failed to fetch places" });
    }
};

exports.getPlaceDetails = async (req, res) => {
    try {
        const { place_id } = req.query;
        if (!place_id) return res.status(400).json({ message: "Place ID is required" });

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ message: "Google Places API Key not configured" });
        }

        const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
        url.searchParams.append('place_id', place_id);
        url.searchParams.append('fields', 'name,formatted_address,address_components,geometry,formatted_phone_number,website');
        url.searchParams.append('key', apiKey);

        const response = await fetch(url.toString());
        const data = await response.json();

        res.json(data);
    } catch (error) {
        console.error("Error fetching place details:", error);
        res.status(500).json({ message: "Failed to fetch place details" });
    }
};
