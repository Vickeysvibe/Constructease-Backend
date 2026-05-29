import Todos from "../Models/Todos.model.js";
import Sites from "../Models/Sites.model.js";

export const createTodo = async (req, res) => {
  try {
    const { id, task, start, end, additionalCols } = req.body;
    const { siteId } = req.query;

    if (!siteId || !task || !start || !end) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const site = await Sites.findById(siteId);
    if (!site) {
      return res.status(404).json({ message: "Site not found" });
    }

    if (id) {
      const existingTodo = await Todos.findById(id);
      if (!existingTodo) {
        return res.status(404).json({ message: "Todo not found" });
      }
      existingTodo.task = task;
      existingTodo.start = start;
      existingTodo.end = end;
      existingTodo.additionalCols = additionalCols || {};
      await existingTodo.save();
      res
        .status(200)
        .json({ message: "Todo updated successfully", todo: existingTodo });
      return;
    }
    const newColumns = Object.keys(additionalCols || {});
    if (newColumns.length > 0) {
      const existingTodos = await Todos.find({ siteId }).lean();

      if (existingTodos.length > 0) {
        const updateFields = {};
        newColumns.forEach((col) => {
          if (!Object.keys(existingTodos[0].additionalCols).includes(col))
            updateFields[`additionalCols.${col}`] = "";
        });

        await Todos.updateMany({ siteId }, { $set: updateFields });
      }
    }

    const newTodo = new Todos({
      task,
      start,
      end,
      additionalCols: additionalCols || {},
      siteId,
    });

    await newTodo.save();
    res
      .status(201)
      .json({ message: "Todo created successfully", todo: newTodo });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const addColumn = async (req, res) => {
  try {
    const { siteId } = req.query;
    const { columnName } = req.body;

    if (!siteId || !columnName) {
      return res
        .status(400)
        .json({ message: "Site ID and column name are required" });
    }

    if (/^[@.$#]/.test(columnName)) {
      return res
        .status(400)
        .json({ message: "Column name must not start with @, ., $, or #" });
    }

    const existingTodos = await Todos.find({ siteId });

    if (existingTodos.length === 0) {
      return res.status(404).json({ message: "No todos found for this site" });
    }

    const updateFields = {};
    updateFields[`additionalCols.${columnName}`] = "";

    await Todos.updateMany({ siteId }, { $set: updateFields });

    res.status(200).json({
      message: `Column '${columnName}' added successfully to all todos for site ${siteId}`,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAllTodos = async (req, res) => {
  try {
    const { siteId } = req.query;

    if (!siteId) {
      return res
        .status(400)
        .json({ message: "siteId is required in the query" });
    }

    const todos = await Todos.find({ siteId }).populate(
      "siteId",
      "siteName siteAddress"
    );
    res.status(200).json(todos);
  } catch (error) {
    res
      .status(500)
      .json({ message: error.message, redirectUrl: "http://....." });
  }
};

export const getTodoById = async (req, res) => {
  try {
    const { todoId } = req.params;
    const todo = await Todos.findById(todoId).populate(
      "siteId",
      "siteName siteAddress"
    );

    if (!todo) {
      return res.status(404).json({ message: "Todo not found" });
    }

    res.status(200).json(todo);
  } catch (error) {
    res
      .status(500)
      .json({ message: error.message, redirectUrl: "http://....." });
  }
};

export const updateTodo = async (req, res) => {
  try {
    const { todoId } = req.params;
    const { task, start, end, additionalCols } = req.body;

    if (additionalCols) {
      for (const key in additionalCols) {
        if (/^[@.$#]/.test(key)) {
          return res.status(400).json({
            message: `Column name '${key}' must not start with @, ., $, or #`,
          });
        }
      }
    }

    const updatedTodo = await Todos.findByIdAndUpdate(
      todoId,
      {
        $set: {
          ...(task && { task }),
          ...(start && { start }),
          ...(end && { end }),
          ...(additionalCols && { additionalCols }),
        },
      },
      { new: true }
    );

    if (!updatedTodo) {
      return res.status(404).json({ message: "Todo not found" });
    }

    res
      .status(200)
      .json({ message: "Todo updated successfully", todo: updatedTodo });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteTodo = async (req, res) => {
  try {
    const { todoId } = req.params;
    console.log(todoId);
    const deletedTodo = await Todos.findByIdAndDelete(todoId);

    if (!deletedTodo) {
      return res.status(404).json({ message: "Todo not found" });
    }

    res.status(200).json({ message: "Todo deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: error.message, redirectUrl: "http://....." });
  }
};

export const deleteColumn = async (req, res) => {
  try {
    const { siteId } = req.query;
    const { columnName } = req.body;

    if (!siteId || !columnName) {
      return res
        .status(400)
        .json({ message: "Site ID and column name are required" });
    }

    if (/^[@.$#]/.test(columnName)) {
      return res
        .status(400)
        .json({ message: "Column name must not start with @, ., $, or #" });
    }

    const existingTodos = await Todos.find({ siteId });

    if (existingTodos.length === 0) {
      return res.status(404).json({ message: "No todos found for this site" });
    }

    const updateFields = {};
    updateFields[`additionalCols.${columnName}`] = 1;

    await Todos.updateMany({ siteId }, { $unset: updateFields });

    res.status(200).json({
      message: `Column '${columnName}' deleted successfully from all todos for site ${siteId}`,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
export const editColumn = async (req, res) => {
  try {
    const { siteId } = req.query;
    const { oldColumnName, newColumnName } = req.body;

    if (!siteId || !oldColumnName || !newColumnName) {
      return res.status(400).json({
        message: "Site ID, old column name, and new column name are required",
      });
    }

    if (/^[@.$#]/.test(newColumnName)) {
      return res
        .status(400)
        .json({ message: "New column name must not start with @, ., $, or #" });
    }

    const existingTodos = await Todos.find({ siteId });

    if (existingTodos.length === 0) {
      return res.status(404).json({ message: "No todos found for this site" });
    }

    // Rename additionalCols key properly
    await Todos.updateMany({ siteId }, [
      {
        $set: {
          [`additionalCols.${newColumnName}`]: `$additionalCols.${oldColumnName}`,
        },
      },
      {
        $unset: [`additionalCols.${oldColumnName}`],
      },
    ]);

    res.status(200).json({
      message: `Column '${oldColumnName}' renamed to '${newColumnName}' successfully for site ${siteId}`,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

