const generateManifestId = () => {
    return `MF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
};

const generateBagId = () => {
    return `BAG-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
};

module.exports = {
    generateManifestId,
    generateBagId
};
