const fs = require('fs');
const path = require('path');

const usersFile = path.join(__dirname, '../data/users.json');

function loadUsers() {
  try {
    const data = fs.readFileSync(usersFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error("Error loading users:", error);
    return {};
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), 'utf8');
    console.log("Users saved successfully.");
    return true;
  } catch (error) {
    console.error("Error saving users:", error);
    return false;
  }
}

function registerUser(id, nombre, cargo, rol) {
  const users = loadUsers();
  users[id] = { nombre, cargo, rol };
  return saveUsers(users);
}

function getUser(id) {
  const users = loadUsers();
  return users[id] || null;
}

module.exports = {
  registerUser,
  getUser,
  loadUsers,
  saveUsers
};


//User manager final