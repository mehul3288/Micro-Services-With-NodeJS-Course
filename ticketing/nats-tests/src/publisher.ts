import nats from "node-nats-streaming"
import { TicketCreatedPublisher } from "./events/ticket-created-publisher";

console.clear();

const stan = nats.connect("ticketing", "abc", {
    url: "http://localhost:4222"
});

stan.on("connect", async () => {
    console.log("Connected to NATS");

    const publisher = new TicketCreatedPublisher(stan);
    try {
        await publisher.publish({
            id: "123",
            title: "concert",
            price: 919
        });
    } catch (error) {
        console.error(error);
    }

    // const data = {
    //     id: "123",
    //     title: "concert",
    //     price: 99
    // };

    // stan.publish("ticket:created", JSON.stringify(data), () => {
    //     console.log("Event published");
    // });
});