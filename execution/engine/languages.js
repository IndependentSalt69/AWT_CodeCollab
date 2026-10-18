// Shared by the API and worker; deliberately has no Docker dependencies.
const LANGUAGE_IMAGE_MAP = Object.freeze({
  python: 'codecollab-runner-python:latest',
  cpp: 'codecollab-runner-cpp:latest',
  java: 'codecollab-runner-java:latest',
});
const EXECUTABLE_LANGUAGES = Object.freeze(Object.keys(LANGUAGE_IMAGE_MAP));
module.exports = { LANGUAGE_IMAGE_MAP, EXECUTABLE_LANGUAGES };
