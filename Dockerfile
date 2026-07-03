FROM nginx:alpine

COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/styles.css
COPY app.js /usr/share/nginx/html/app.js
COPY assets/recodify-utilities.png /usr/share/nginx/html/assets/recodify-utilities.png
COPY assets/rocket-mark.png /usr/share/nginx/html/assets/rocket-mark.png

EXPOSE 80
