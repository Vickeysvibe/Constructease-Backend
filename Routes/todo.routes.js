import express from "express";
import {
  createTodo,
  getAllTodos,
  getTodoById,
  deleteTodo,
  updateTodo,
  editColumn,
  addColumn,
  deleteColumn,
} from "../Controllers/todo.controller.js";

const router = express.Router();

router.post("/create-todo", createTodo);

router.get("/getall", getAllTodos);

router.put("/updatetodo", updateTodo);

router.put("/updatecolumn", editColumn);

router.post("/addcolumn", addColumn);

router.delete("/deletecolumn", deleteColumn);

router.get("/getbyid/:todoId", getTodoById);

router.delete("/delete/:todoId", deleteTodo);

export default router;
