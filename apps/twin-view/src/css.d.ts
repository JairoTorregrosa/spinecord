// A stylesheet imported as text (`with { type: "text" }`): the chat panel injects its own only when the chat is on.
declare module "*.css" {
  const text: string;
  export default text;
}
