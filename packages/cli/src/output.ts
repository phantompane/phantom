export const output = {
  log: (message: string) => {
    console.log(message);
  },

  error: (message: string) => {
    console.error(message);
  },

  warn: (message: string) => {
    console.warn(message);
  },

  table: (data: unknown) => {
    console.table(data);
  },
};
