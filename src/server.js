const express = require('express')
const app = express()
const port = 3001

app.use(express.static('public/standings'));

app.get('/', (req, res) => {
  res.send('OK')
})

app.listen(port, () => {
  console.log(`App listening on port ${port}`)
})
