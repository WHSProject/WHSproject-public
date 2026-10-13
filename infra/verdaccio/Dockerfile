# WHSProject Verdaccio 이미지
#
# 공식 이미지에 AWS S3 Storage Plugin 만 더한다. 설정·WHS Plugin 은 지금처럼
# compose 에서 마운트한다. 로컬 저장소 구성(WHS_STORAGE_MODE=local)에서는 이 Plugin 을
# 쓰지 않으므로 공식 이미지와 똑같이 동작한다.
FROM verdaccio/verdaccio:6.10.0

# /verdaccio/plugins 는 저장소의 plugins 폴더로 덮이므로 그 밖에 설치한다.
# Verdaccio 는 plugins 폴더에서 못 찾은 Plugin 을 패키지 이름으로 한 번 더 찾는다.
# 이 Plugin 은 ESM 이라 import 로 불리고, import 는 NODE_PATH 를 보지 않는다.
# Verdaccio 설치 위치에서 올라가며 찾는 /usr/local/lib/node_modules 에 링크를 둔다.
USER root
WORKDIR /opt/whs-storage-plugins
COPY storage-plugins/package.json storage-plugins/package-lock.json ./
# lockfile 그대로 설치하고 설치 스크립트는 실행하지 않는다.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force \
  && ln -s /opt/whs-storage-plugins/node_modules/verdaccio-aws-s3-storage \
    /usr/local/lib/node_modules/verdaccio-aws-s3-storage

# 공식 이미지와 같은 실행 사용자·작업 폴더로 되돌린다.
USER 10001
WORKDIR /opt/verdaccio
