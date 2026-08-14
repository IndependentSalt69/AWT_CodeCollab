const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('CodeCollab Server'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
