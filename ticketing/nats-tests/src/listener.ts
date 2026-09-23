import nats, { Message, Stan } from "node-nats-streaming";
import { randomBytes } from "node:crypto";
import { TicketCreatedListener } from "./events/ticket-created-listener";
import { Subjects } from "./events/subjects";
//Just tested code:
// console.clear();
// const stan = nats.connect("ticketing", randomBytes(4).toString("hex"), {
//     url: "http://localhost:4222"
// });

// stan.on('connect', () => {
//     console.log("connected to nats");
//     stan.on("close", () => {
//         console.log("Nats Connection closed!");
//         process.exit();

//     })
//     const options = stan
//         .subscriptionOptions()
//         .setManualAckMode(true)
//         .setDeliverAllAvailable() //It will send all the events delivered in the past 
//         .setDurableName("orders-service") //It will
//     const subscription = stan.subscribe("ticket:created", "orders-service-queue-group", options);
//     // const subscription = stan.subscribe("ticket:created", options);
//     subscription.on('message', (msg: Message) => {
//         console.log("Message received");
//         const data = msg.getData();
//         if (typeof data === "string") {
//             console.log("Received event #" + msg.getSequence() + ":", data);
//         }
//         msg.ack();
//         // console.log(msg.getData());
//     });
// });

// //Interrupt signal when we try to close the terminal
// process.on("SIGINT", () => stan.close());
// process.on("SIGTERM", () => stan.close());


const stan = nats.connect("ticketing", randomBytes(4).toString("hex"), {
    url: "http://localhost:4222"
});

stan.on('connect', () => {
    console.log("connected to nats");
    stan.on("close", () => {
        console.log("Nats Connection closed!");
        process.exit();

    })
    new TicketCreatedListener(stan).listen();
});

//Interrupt signal when we try to close the terminal
process.on("SIGINT", () => stan.close());
process.on("SIGTERM", () => stan.close());



