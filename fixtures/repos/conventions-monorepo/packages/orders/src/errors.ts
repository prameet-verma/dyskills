export class OrderNotFoundError extends Error {
  constructor(public orderId: string) {
    super("order " + orderId + " not found");
    this.name = "OrderNotFoundError";
  }
}

export class InvalidOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderError";
  }
}
