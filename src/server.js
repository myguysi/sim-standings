const express = require('express')
const app = express()
const port = 3001

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('OK')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
