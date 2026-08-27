const { City, State } = require('country-state-city');

const INDIA_COUNTRY_CODE = 'IN';

exports.getIndianStates = (req, res) => {
    const states = State.getStatesOfCountry(INDIA_COUNTRY_CODE)
        .map(({ name, isoCode }) => ({ name, isoCode }))
        .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ states });
};

exports.getIndianCities = (req, res) => {
    const stateCode = String(req.query.stateCode || '').trim().toUpperCase();
    const state = State.getStateByCodeAndCountry(stateCode, INDIA_COUNTRY_CODE);

    if (!state) {
        return res.status(400).json({ message: 'A valid Indian state code is required' });
    }

    const cities = City.getCitiesOfState(INDIA_COUNTRY_CODE, stateCode)
        .map(({ name }) => name)
        .filter((name, index, allCities) => allCities.indexOf(name) === index)
        .sort((a, b) => a.localeCompare(b));

    return res.json({ state: { name: state.name, isoCode: state.isoCode }, cities });
};

exports.searchPlaces = async (req, res) => {
    try {
        const input = String(req.query.input || '').trim();

        if (!input) {
            return res.status(400).json({ message: "Input is required" });
        }

        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey) {
            console.error("Google Places API key is not configured");
            return res.status(500).json({ message: "Google Places API Key not configured" });
        }

        const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
        url.searchParams.append('input', input);
        url.searchParams.append('key', apiKey);
        url.searchParams.append('components', 'country:in');

        const response = await fetch(url.toString());
        const data = await response.json();

        if (!response.ok) {
            console.error(`Google Places autocomplete request failed with status ${response.status}`);
        }

        return res.json(data);
    } catch (error) {
        console.error("Google Places autocomplete request failed:", error.message);
        return res.status(500).json({ message: "Failed to fetch places" });
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

        if (!response.ok) {
            console.error(`Google Places details request failed with status ${response.status}`);
        }

        return res.json(data);
    } catch (error) {
        console.error("Google Places details request failed:", error.message);
        return res.status(500).json({ message: "Failed to fetch place details" });
    }
};
