const express = require("express");
const bodyParser = require("body-parser");
const { randomBytes } = require("crypto")
const cors = require("cors")
const axios = require("axios")
const app = express();
app.use(bodyParser.json());
app.use(cors());
const commentsByPostId = {};

app.get("/posts/:id/comments", (req, res) => {
    res.send(commentsByPostId[req.params.id] || [])
})

app.post("/posts/:id/comments", async (req, res) => {
    const commentId = randomBytes(4).toString("hex");
    const { content } = req.body;
    const comments = commentsByPostId[req.params.id] || []
    comments.push({ id: commentId, content });
    commentsByPostId[req.params.id] = comments;
    await axios.post("http://event-bus-srv:4005/events", {
        type: "CommentCreated",
        data: {
            id: commentId,
            content,
            postId: req.params.id,
            status: "pending"
        }
    })
    res.status(201).send(comments)

})

app.post("/events", async (req, res) => {
    const eventType = req.body.type;
    //All the domain related updated should be done in the appropriate service and not inside the query service(presentation service) because in future there can be many more service which also depends on that so we will need to process events in all the services instead we should process it in the services which owns that data and all the other presentation service should consume the event to fetch the data from the query service and just update their own data as it is received from the event.
    if (eventType === "CommentModerated") {
        const { id, content, postId, status } = req.body.data;

        const comments = commentsByPostId[postId];

        const comment = comments.find(comment => comment.id === id);
        comment.status = status;
        await axios.post("http://event-bus-srv:4005/events", {
            type: "CommentUpdated",
            data: {
                id,
                content,
                postId,
                status
            }
        })
    }
    console.log("Received Event", req.body.type);
    res.send({});
})

app.listen(4001, () => {
    console.log("Listening on port 4001")
})