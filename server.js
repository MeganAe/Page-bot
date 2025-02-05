const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const axios = require('axios'); 

const app = express();
app.use(bodyParser.json());

app.use(express.static('public'));

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; 
const VERIFY_TOKEN = "lorex";

let imageHistory = {};

app.get('/webhook', (req, res) => {
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.status(403).send('Verification failed.');
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        await Promise.all(
            body.entry.map(async (entry) => {
                const webhookEvent = entry.messaging[0];
                const senderId = webhookEvent.sender.id;
                const message = webhookEvent.message;
                const attachments = message?.attachments;

                if (message) {
                    if (attachments && attachments[0].type === 'image') {
                        const imageUrl = attachments[0].payload.url;
                        imageHistory[senderId] = imageUrl; 

                        const response = {
                            text: 'Image received! Now, you can use the "/gemini" command with any prompt to analyze the image.'
                        };
                        sendMessage(senderId, response);
                        return;
                    }

                    const receivedMessage = message.text;

                    markAsSeen(senderId);

                    if (receivedMessage.startsWith('/gemini')) {
                        const prompt = receivedMessage.replace('/gemini', '').trim();

                        const imageUrl = imageHistory[senderId];
                        if (imageUrl) {
                            analyzeImageWithGemini(senderId, prompt, imageUrl);
                        } else {
                            sendMessage(senderId, "No image found. Please send an image first.");
                        }
                    } else if (receivedMessage.startsWith('/play')) {
                        const args = receivedMessage.split(' ').slice(1);
                        playSong(senderId, args);
                    } else if (receivedMessage.startsWith('/imagine')) {
                        const prompt = receivedMessage.replace('/imagine', '').trim();
                        generateImage(senderId, prompt);
                    } else {
                        const apiUrl = `https://kaiz-apis.gleeze.com/api/gpt-4o?q=${encodeURIComponent(receivedMessage)}&uid=${senderId}`;
                        request(apiUrl, { json: true }, (error, response, body) => {
                            if (!error && body.response) {
                                const reply = `${body.response}`;
                                sendMessage(senderId, reply);
                            } else {
                                console.error("API error:", error || body);
                                sendMessage(senderId, "Sorry, I couldn't process your request. Please try again later.");
                            }
                        });
                    }
                }
            })
        );

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.status(404).send('Not Found');
    }
});

function markAsSeen(recipientId) {
    const requestBody = {
        recipient: { id: recipientId },
        sender_action: "mark_seen"
    };

    request.post({
        url: 'https://graph.facebook.com/v21.0/me/messages',
        qs: { access_token: PAGE_ACCESS_TOKEN },
        json: requestBody
    }, (error, response, body) => {
        if (error) {
            console.error('Unable to mark as seen:', error);
        } else {
            console.log('Message marked as seen:', body);
        }
    });
}

async function callSendAPI(recipientId, messageData) {
    const requestBody = {
        recipient: { id: recipientId },
        message: messageData,
    };

    try {
        const response = await axios.post('https://graph.facebook.com/v15.0/me/messages', requestBody, {
            params: { access_token: PAGE_ACCESS_TOKEN },
        });
        console.log('Message sent successfully:', response.data);
    } catch (error) {
        console.error('Error sending message:', error.response?.data || error.message);
    }
}

async function analyzeImageWithGemini(senderId, prompt, imageUrl) {
    if (!prompt) {
        sendMessage(senderId, "Please provide a prompt after the /gemini command. Example: /gemini Describe this image");
        return;
    }

    try {
        const apiUrl = `https://kaiz-apis.gleeze.com/api/gemini-vision?q=${encodeURIComponent(prompt)}&uid=${encodeURIComponent(senderId)}&imageUrl=${encodeURIComponent(imageUrl)}`;
        const { data } = await axios.get(apiUrl);
        if (data && data.response) {
            sendMessage(senderId, data.response);
        } else {
            sendMessage(senderId, "Sorry, I couldn't retrieve information for this image. Please try again later.");
        }
    } catch (error) {
        console.error('Error with Gemini API:', error.message);
        sendMessage(senderId, '⛔ There was an error processing your image analysis request. Please try again later.');
    }
}

async function playSong(senderId, args) {
    if (!args || args.length === 0) {
        await callSendAPI(senderId, {
            text: "Please provide a song name or query to search for on Spotify.\n\nExample: Pantropiko",
        });
        return;
    }

    try {
        const { data } = await axios.get(`https://hiroshi-api.onrender.com/tiktok/spotify?search=${encodeURIComponent(args.join(' '))}`);
        const link = data[0]?.download;

        if (link) {
            await callSendAPI(senderId, {
                attachment: {
                    type: 'audio',
                    payload: { url: link, is_reusable: true }
                }
            });
        } else {
            await callSendAPI(senderId, {
                text: 'Sorry, no Spotify link found for that query.'
            });
        }
    } catch (error) {
        console.error('Error playing song:', error);
        await callSendAPI(senderId, {
            text: '⛔ Sorry, there was an error processing your request.'
        });
    }
}

async function generateImage(senderId, prompt) {
    if (!prompt || prompt.trim() === "") {
        await callSendAPI(senderId, {
            text: "Please provide a prompt for the image generation.",
        });
        return;
    }

    try {
        const apiUrl = `https://kaiz-apis.gleeze.com/api/imagine?prompt=${encodeURIComponent(prompt)}`;

        await callSendAPI(senderId, {
            attachment: {
                type: "image",
                payload: {
                    url: apiUrl,
                    is_reusable: true,
                },
            },
        });
    } catch (error) {
        console.error("Error generating image:", error);
        await callSendAPI(senderId, {
            text: "⛔ There was an error processing your image generation request. Please try again later.",
        });
    }
}

function sendMessage(recipientId, messageText) {
    const MAX_CHAR_LIMIT = 2000;

    const sendChunk = (chunk) => {
        const requestBody = { recipient: { id: recipientId }, message: { text: chunk } };

        request.post({
            url: 'https://graph.facebook.com/v21.0/me/messages',
            qs: { access_token: PAGE_ACCESS_TOKEN },
            json: requestBody
        }, (error, response, body) => {
            if (error) {
                console.error('Unable to send message:', error);
            } else {
                console.log('Message sent successfully:', body);
            }
        });
    };

    if (messageText.length > MAX_CHAR_LIMIT) {
        const chunks = [];
        let start = 0;
        while (start < messageText.length) {
            let end = Math.min(start + MAX_CHAR_LIMIT, messageText.length);
            if (end < messageText.length && messageText[end] !== ' ') {
                end = messageText.lastIndexOf(' ', end);
            }
            if (end <= start) end = Math.min(start + MAX_CHAR_LIMIT, messageText.length);

            chunks.push(messageText.substring(start, end).trim());
            start = end + 1;
        }

        chunks.forEach((chunk, index) => {
            setTimeout(() => sendChunk(chunk), index * 1000);
        });
    } else {
        sendChunk(messageText);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
