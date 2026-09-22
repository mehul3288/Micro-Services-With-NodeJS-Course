import nats from "node-nats-streaming"

console.clear();

const stan = nats.connect("ticketing", "abc", {
    url: "http://localhost:4222"
});

stan.on("connect", () => {
    console.log("Connected to NATS");

    const data = {
        id: "123",
        title: "concert",
        price: 99
    };

    stan.publish("ticket:created", JSON.stringify(data), () => {
        console.log("Event published");
    });
});