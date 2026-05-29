import axios from 'axios';

const apiUrl = 'http://localhost:8000/api/labour/create';  // Replace with your actual API endpoint
const siteId = '67966d2720c0ea128ef9fba1';  // Replace with the actual siteId

const labours = [
    // Category: Carpenter
    { name: 'Labour 11', phoneNo: '9876543201', category: 'Carpenter', subCategory: 'Framework', wagesPerShift: 500 },
   
];

const bearerToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbmdpbmVlcklkIjoiNjc4YzdkOGI2ZjM1MWU2YmY1MjkwN2ZlIiwic3VwZXJ2aXNvcklkIjoiNjc5NjZkNjIyMGMwZWExMjhlZjlmYmE2Iiwicm9sZSI6IlN1cGVydmlzb3IiLCJpYXQiOjE3Mzc5NDg4MTEsImV4cCI6MTczNzk5MjAxMX0.kFBltlW-Bz3KGrBbGwCJ9sL6T1DUxC1zNCN2rAN1do0';

const addLabours = async () => {
    for (const labour of labours) {
        try {
            const response = await axios.post(
                `${apiUrl}?siteId=${siteId}`,
                labour,
                {
                    headers: {
                        'Authorization': `Bearer ${bearerToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log(`Success: ${response.data.message}`, response.data.labour);
        } catch (error) {
            console.error(`Error adding ${labour.name}:`, error.response ? error.response.data : error.message);
        }
    }
};

addLabours();
