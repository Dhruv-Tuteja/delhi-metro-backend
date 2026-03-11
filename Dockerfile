FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install only production dependencies for a smaller, faster build
RUN npm install --omit=dev

# Bundle app source - This copies EVERYTHING (routes, services, utils, etc.)
COPY . .

# Match the port in your index.js
ENV PORT=3001
EXPOSE 3001

CMD [ "node", "src/index.js" ]